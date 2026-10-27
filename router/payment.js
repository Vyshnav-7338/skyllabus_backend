const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Stripe = require("stripe");
const User = require("../models/User");
const Product = require("../models/Product");
const Enrollment = require("../models/Enrollment");
const Payment = require("../models/Payment");
const { toMinorUnits } = require("../utils/money");
const { sendApiError } = require("../utils/api-error");
require("dotenv").config();
const FRONTEND_URL =
"http://68.178.168.48:5000/";
const router = express.Router();
let stripe;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

function stripeClient(req) {
  if (req?.app?.locals?.stripe) return req.app.locals.stripe;
  if (!STRIPE_SECRET_KEY) {
    const error = new Error("Stripe is not configured");
    error.statusCode = 503;
    throw error;
  }
  stripe ||= new Stripe(STRIPE_SECRET_KEY);
  return stripe;
}

async function requireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return res.status(401).json({ success: false, message: "Authentication required" });
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user || user.status === "disabled") return res.status(401).json({ success: false, message: "User is unavailable" });
    req.user = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

function paymentError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function checkoutUrls(productId) {
  const frontendUrl = String(FRONTEND_URL || "").trim();
  if (!frontendUrl) throw paymentError("Payment redirect URL is not configured", 503);
  let base;
  try {
    base = new URL(frontendUrl);
  } catch (_error) {
    throw paymentError("Payment redirect URL is invalid", 503);
  }
  if (!(["http:", "https:"].includes(base.protocol))) throw paymentError("Payment redirect URL is invalid", 503);
  const success = new URL("payment/success", base.href.endsWith("/") ? base : `${base.href}/`);
  success.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
  const cancel = new URL("payment/cancel", base.href.endsWith("/") ? base : `${base.href}/`);
  cancel.searchParams.set("course_id", productId.toString());
  return {
    successUrl: success.toString().replace(encodeURIComponent("{CHECKOUT_SESSION_ID}"), "{CHECKOUT_SESSION_ID}"),
    cancelUrl: cancel.toString(),
  };
}

async function getReusableSession(stripeApi, payment) {
  if (!payment.checkoutSessionId) return null;
  const session = await stripeApi.checkout.sessions.retrieve(payment.checkoutSessionId);
  if (session.status === "open") return session;
  if (session.payment_status === "paid") throw paymentError("Payment is already being confirmed", 409);
  payment.paymentStatus = session.status === "expired" ? "expired" : "cancelled";
  payment.enrollmentStatus = "not_created";
  payment.activeKey = undefined;
  await payment.save();
  return null;
}

router.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const productId = String(req.body?.courseId || req.body?.productId || "");
    if (!mongoose.isValidObjectId(productId)) throw paymentError("Invalid course ID", 400);
    const product = await Product.findOne({ _id: productId, isPublished: true, isActive: { $ne: false } });
    if (!product) throw paymentError("Course not found or unavailable", 404);
    if (await Enrollment.exists({ user: req.user._id, product: product._id, status: { $ne: "cancelled" } })) {
      throw paymentError("You are already enrolled in this course", 409);
    }

    const price = product.offerPrice > 0 ? product.offerPrice : product.price;
    const amount = toMinorUnits(price);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw paymentError("This course does not require Stripe payment", 400);
    const currency = String(product.currency || "").trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) throw paymentError("Course currency is invalid", 409);

    const activeKey = `${req.user._id}:${product._id}`;
    const stripeApi = stripeClient(req);
    let payment = await Payment.findOne({ activeKey });
    if (payment) {
      const reusable = await getReusableSession(stripeApi, payment);
      if (reusable) {
        return res.json({ success: true, data: { sessionId: reusable.id, url: reusable.url } });
      }
    }

    try {
      payment = await Payment.create({
        user: req.user._id,
        product: product._id,
        amount,
        currency,
        activeKey,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      payment = await Payment.findOne({ activeKey });
      if (!payment) throw error;
      const reusable = await getReusableSession(stripeApi, payment);
      if (reusable) return res.json({ success: true, data: { sessionId: reusable.id, url: reusable.url } });
    }

    const { successUrl, cancelUrl } = checkoutUrls(product._id);
    const metadata = {
      userId: req.user._id.toString(),
      courseId: product._id.toString(),
      paymentId: payment._id.toString(),
    };
    const session = await stripeApi.checkout.sessions.create({
      mode: "payment",
      customer_email: req.user.email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amount,
          product_data: { name: product.title.slice(0, 127), metadata: { courseId: product._id.toString() } },
        },
      }],
      metadata,
      payment_intent_data: { metadata },
      success_url: successUrl,
      cancel_url: cancelUrl,
    }, { idempotencyKey: `skyllabus-checkout-${payment._id}` });

    payment.checkoutSessionId = session.id;
    await payment.save();
    return res.status(201).json({ success: true, data: { sessionId: session.id, url: session.url } });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to start payment" });
  }
});

router.get("/session/:sessionId/status", requireAuth, async (req, res) => {
  try {
    const payment = await Payment.findOne({ checkoutSessionId: req.params.sessionId, user: req.user._id });
    if (!payment) return res.status(404).json({ success: false, message: "Payment session not found" });
    const enrollment = await Enrollment.findOne({ user: req.user._id, product: payment.product, status: { $ne: "cancelled" } });
    return res.json({
      success: true,
      data: {
        sessionId: payment.checkoutSessionId,
        courseId: payment.product.toString(),
        paymentStatus: payment.paymentStatus,
        enrollmentStatus: payment.enrollmentStatus,
        enrolled: Boolean(enrollment),
      },
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to check payment status" });
  }
});

async function completeCheckout(session, eventId) {
  if (session.payment_status !== "paid") return;
  const { userId, courseId, paymentId } = session.metadata || {};
  if (![userId, courseId, paymentId].every(mongoose.isValidObjectId)) throw paymentError("Stripe session metadata is invalid", 400);
  const databaseSession = await mongoose.startSession();
  try {
    await databaseSession.withTransaction(async () => {
      const payment = await Payment.findOne({ _id: paymentId, checkoutSessionId: session.id }).session(databaseSession);
      if (!payment) throw paymentError("Payment record not found", 404);
      if (payment.user.toString() !== userId || payment.product.toString() !== courseId) {
        throw paymentError("Stripe session metadata does not match the payment", 400);
      }
      if (payment.amount !== session.amount_total || payment.currency !== String(session.currency || "").toLowerCase()) {
        throw paymentError("Stripe payment amount does not match the course price", 400);
      }

      let enrollment = await Enrollment.findOne({ user: payment.user, product: payment.product }).session(databaseSession);
      if (!enrollment) {
        [enrollment] = await Enrollment.create([{ user: payment.user, product: payment.product }], { session: databaseSession });
        await Product.updateOne({ _id: payment.product }, { $inc: { enrollmentCount: 1 } }, { session: databaseSession });
      }
      payment.paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      payment.paymentStatus = "paid";
      payment.enrollmentStatus = "completed";
      payment.paidAt ||= new Date((session.created || Math.floor(Date.now() / 1000)) * 1000);
      payment.lastWebhookEventId = eventId;
      payment.activeKey = undefined;
      await payment.save({ session: databaseSession });
    });
  } finally {
    await databaseSession.endSession();
  }
}

async function stripeWebhook(req, res) {
  let event;
  try {
    if (!STRIPE_WEBHOOK_SECRET) throw paymentError("Stripe webhook is not configured", 503);
    event = stripeClient(req).webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, message: error.statusCode === 503 ? error.message : "Invalid Stripe webhook signature" });
  }

  try {
    const checkout = event.data.object;
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      await completeCheckout(checkout, event.id);
    } else if (["checkout.session.async_payment_failed", "checkout.session.expired"].includes(event.type)) {
      await Payment.updateOne(
        { checkoutSessionId: checkout.id, paymentStatus: { $ne: "paid" } },
        {
          $set: {
            paymentStatus: event.type.endsWith("expired") ? "expired" : "failed",
            enrollmentStatus: "not_created",
            lastWebhookEventId: event.id,
          },
          $unset: { activeKey: 1 },
        },
      );
    }
    return res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    return res.status(error.statusCode || 500).json({ success: false, message: "Unable to process Stripe webhook" });
  }
}

module.exports = { paymentRouter: router, stripeWebhook };
