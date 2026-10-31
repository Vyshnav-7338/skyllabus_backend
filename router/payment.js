const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Stripe = require("stripe");

require("dotenv").config();

const User = require("../models/User");
const Product = require("../models/Product");
const Enrollment = require("../models/Enrollment");
const Payment = require("../models/Payment");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const ReferralSettings = require("../models/ReferralSettings");
const ReferralCommission = require("../models/ReferralCommission");

const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const { sendApiError } = require("../utils/api-error");

const router = express.Router();

// ============================================================
// ENVIRONMENT CONFIGURATION
// ============================================================

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const JWT_SECRET='local-development-secret-change-before-production'




// You can move this to .env later:
// FRONTEND_URL=https://skyllabus.online/
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://skyllabus.online/";

// Convenience-fee wallet beneficiary. The account is created automatically
// on the first successful payment if it does not already exist.
const CONVENIENCE_WALLET_EMAIL = String(
  process.env.CONVENIENCE_WALLET_EMAIL || "vyshnav@gm.com"
).trim().toLowerCase();
const CONVENIENCE_WALLET_PASSWORD = String(
  process.env.CONVENIENCE_WALLET_PASSWORD || "12345"
);

async function generateSystemReferralCode(databaseSession) {
  while (true) {
    const code = `SKYWAL${Math.floor(100000 + Math.random() * 900000)}`;
    const exists = await User.exists({ referralCode: code }).session(databaseSession);
    if (!exists) return code;
  }
}

async function generateSystemPhone(databaseSession) {
  while (true) {
    const phone = `+919${Math.floor(100000000 + Math.random() * 900000000)}`;
    const exists = await User.exists({ phone }).session(databaseSession);
    if (!exists) return phone;
  }
}

async function ensureConvenienceWalletUser(databaseSession) {
  let beneficiary = await User.findOne({
    email: CONVENIENCE_WALLET_EMAIL,
  }).session(databaseSession);

  if (!beneficiary) {
    const referralCode = await generateSystemReferralCode(databaseSession);
    const phone = await generateSystemPhone(databaseSession);

    [beneficiary] = await User.create(
      [{
        name: "Vyshnav",
        email: CONVENIENCE_WALLET_EMAIL,
        phone,
        password: CONVENIENCE_WALLET_PASSWORD,
        role: "admin",
        status: "active",
        referralCode,
      }],
      { session: databaseSession }
    );
  }

  let wallet = await Wallet.findOne({ user: beneficiary._id }).session(databaseSession);
  if (!wallet) {
    [wallet] = await Wallet.create([{ user: beneficiary._id }], { session: databaseSession });
  }

  return { beneficiary, wallet };
}

async function creditEnrollmentReferralRewards(payment, enrollment, databaseSession) {
  const sourceUser = await User.findById(payment.user).session(databaseSession);
  if (!sourceUser?.referredBy) return;

  const settings = await ReferralSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { returnDocument: "after", upsert: true, runValidators: true, session: databaseSession }
  );
  if (!settings?.isActive) return;

  const visited = new Set([sourceUser._id.toString()]);
  let upline = await User.findById(sourceUser.referredBy).session(databaseSession);

  for (let level = 1; level <= 5 && upline; level += 1) {
    const uplineId = upline._id.toString();
    if (visited.has(uplineId)) throw paymentError("Invalid referral hierarchy", 409);
    visited.add(uplineId);

    const amountMinor = toMinorUnits(settings[`level${level}Reward`] || 0);
    const eventKey = `ENROLLMENT_REFERRAL:${enrollment._id}:UPLINE:${upline._id}:LEVEL:${level}`;
    const exists = await WalletTransaction.exists({ eventKey }).session(databaseSession);

    if (amountMinor > 0 && !exists) {
      let wallet = await Wallet.findOne({ user: upline._id }).session(databaseSession);
      if (!wallet) [wallet] = await Wallet.create([{ user: upline._id }], { session: databaseSession });

      const beforeMinor = toMinorUnits(wallet.availableBalance);
      wallet.availableBalance = fromMinorUnits(beforeMinor + amountMinor);
      wallet.totalCredits = fromMinorUnits(toMinorUnits(wallet.totalCredits) + amountMinor);
      await wallet.save({ session: databaseSession });

      await WalletTransaction.create([{
        user: upline._id,
        type: "CREDIT",
        transactionType: "REFERRAL_REWARD",
        amount: fromMinorUnits(amountMinor),
        referralLevel: level,
        referredUser: sourceUser._id,
        product: payment.product,
        balanceBefore: fromMinorUnits(beforeMinor),
        balanceAfter: wallet.availableBalance,
        description: `Level ${level} referral enrollment reward`,
        reference: enrollment._id.toString(),
        eventKey,
      }], { session: databaseSession });

      await ReferralCommission.create([{
        beneficiary: upline._id,
        sourceUser: sourceUser._id,
        level,
        amount: fromMinorUnits(amountMinor),
        triggerType: "enrollment",
        status: "credited",
      }], { session: databaseSession });
    }

    upline = upline.referredBy
      ? await User.findById(upline.referredBy).session(databaseSession)
      : null;
  }
}

async function creditConvenienceFee(payment, databaseSession) {
  const feeMinor = Number(payment.convenienceFee || 0);
  if (!Number.isSafeInteger(feeMinor) || feeMinor <= 0) return;

  const eventKey = `CONVENIENCE_FEE:PAYMENT:${payment._id}`;
  const alreadyCredited = await WalletTransaction.exists({ eventKey }).session(databaseSession);
  if (alreadyCredited) return;

  const { beneficiary, wallet } = await ensureConvenienceWalletUser(databaseSession);
  const balanceBeforeMinor = toMinorUnits(wallet.availableBalance);
  const balanceAfterMinor = balanceBeforeMinor + feeMinor;

  wallet.availableBalance = fromMinorUnits(balanceAfterMinor);
  wallet.totalCredits = fromMinorUnits(toMinorUnits(wallet.totalCredits) + feeMinor);
  await wallet.save({ session: databaseSession });

  await WalletTransaction.create(
    [{
      user: beneficiary._id,
      type: "CREDIT",
      transactionType: "CONVENIENCE_FEE",
      amount: fromMinorUnits(feeMinor),
      product: payment.product,
      balanceBefore: fromMinorUnits(balanceBeforeMinor),
      balanceAfter: fromMinorUnits(balanceAfterMinor),
      description: "Convenience fee credited from successful course payment",
      reference: payment._id.toString(),
      eventKey,
    }],
    { session: databaseSession }
  );
}

let stripe = null;

// ============================================================
// STRIPE CLIENT
// ============================================================

function stripeClient(req) {
  // If Stripe was already attached to app.locals, use it.
  if (req?.app?.locals?.stripe) {
    return req.app.locals.stripe;
  }

  if (!STRIPE_SECRET_KEY) {
    const error = new Error("Stripe is not configured");
    error.statusCode = 503;
    throw error;
  }

  if (!stripe) {
    stripe = new Stripe(STRIPE_SECRET_KEY);
  }

  return stripe;
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

async function requireAuth(req, res, next) {
  try {
    if (!JWT_SECRET) {
      return res.status(503).json({
        success: false,
        message: "JWT is not configured",
      });
    }

    const header = String(req.headers.authorization || "");

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const token = header.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    if (!payload?.id || !mongoose.isValidObjectId(payload.id)) {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    const user = await User.findById(payload.id);

    if (!user || user.status === "disabled") {
      return res.status(401).json({
        success: false,
        message: "User is unavailable",
      });
    }

    req.user = user;

    return next();
  } catch (error) {
    console.error("Payment auth error:", error.message);

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

// ============================================================
// PAYMENT ERROR HELPER
// ============================================================

function paymentError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// ============================================================
// CHECKOUT SUCCESS / CANCEL URL
// ============================================================

function checkoutUrls(productId) {
  const frontendUrl = String(FRONTEND_URL || "").trim();

  if (!frontendUrl) {
    throw paymentError(
      "Payment redirect URL is not configured",
      503
    );
  }

  let base;

  try {
    base = new URL(frontendUrl);
  } catch (error) {
    throw paymentError(
      "Payment redirect URL is invalid",
      503
    );
  }

  if (!["http:", "https:"].includes(base.protocol)) {
    throw paymentError(
      "Payment redirect URL is invalid",
      503
    );
  }

  const baseUrl = base.href.endsWith("/")
    ? base.href
    : `${base.href}/`;

  const success = new URL(
    "payment/success",
    baseUrl
  );

  success.searchParams.set(
    "session_id",
    "{CHECKOUT_SESSION_ID}"
  );

  const cancel = new URL(
    "payment/cancel",
    baseUrl
  );

  cancel.searchParams.set(
    "course_id",
    productId.toString()
  );

  return {
    successUrl: success
      .toString()
      .replace(
        encodeURIComponent("{CHECKOUT_SESSION_ID}"),
        "{CHECKOUT_SESSION_ID}"
      ),

    cancelUrl: cancel.toString(),
  };
}

// ============================================================
// REUSE EXISTING CHECKOUT SESSION
// ============================================================

async function getReusableSession(
  stripeApi,
  payment
) {
  if (!payment?.checkoutSessionId) {
    return null;
  }

  try {
    const session =
      await stripeApi.checkout.sessions.retrieve(
        payment.checkoutSessionId
      );

    // Existing Checkout session is still usable
    if (session.status === "open") {
      return session;
    }

    // Stripe already received payment.
    if (session.payment_status === "paid") {
      throw paymentError(
        "Payment is already being confirmed",
        409
      );
    }

    payment.paymentStatus =
      session.status === "expired"
        ? "expired"
        : "cancelled";

    payment.enrollmentStatus = "not_created";
    payment.activeKey = undefined;

    await payment.save();

    return null;
  } catch (error) {
    // Don't hide our own payment errors.
    if (error?.statusCode === 409) {
      throw error;
    }

    // If Stripe session no longer exists,
    // release the active payment record.
    if (
      error?.code === "resource_missing" ||
      error?.statusCode === 404
    ) {
      payment.paymentStatus = "expired";
      payment.enrollmentStatus = "not_created";
      payment.activeKey = undefined;

      await payment.save();

      return null;
    }

    throw error;
  }
}

// ============================================================
// CREATE STRIPE CHECKOUT SESSION
// ============================================================

router.post(
  "/create-checkout-session",
  requireAuth,
  async (req, res) => {
    try {
      const productId = String(
        req.body?.courseId ||
        req.body?.productId ||
        ""
      ).trim();

      // --------------------------------------------------------
      // Validate course ID
      // --------------------------------------------------------

      if (!mongoose.isValidObjectId(productId)) {
        throw paymentError(
          "Invalid course ID",
          400
        );
      }

      // --------------------------------------------------------
      // Find course
      // --------------------------------------------------------

      const product = await Product.findOne({
        _id: productId,
        isPublished: true,
        isActive: {
          $ne: false,
        },
      });

      if (!product) {
        throw paymentError(
          "Course not found or unavailable",
          404
        );
      }

      // --------------------------------------------------------
      // Check existing enrollment
      // --------------------------------------------------------

      const alreadyEnrolled =
        await Enrollment.exists({
          user: req.user._id,
          product: product._id,
          status: {
            $ne: "cancelled",
          },
        });

      if (alreadyEnrolled) {
        throw paymentError(
          "You are already enrolled in this course",
          409
        );
      }

      // --------------------------------------------------------
      // Calculate price
      // --------------------------------------------------------

      const price =
        Number(product.offerPrice) > 0
          ? Number(product.offerPrice)
          : Number(product.price);

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        throw paymentError(
          "This course does not require Stripe payment",
          400
        );
      }

      // All payment values below are stored/charged in minor units (paise for INR).
      // Never trust amount values sent by the frontend; calculate them from the DB price.
      const baseAmount = toMinorUnits(price);
      const convenienceFee = Math.round(baseAmount * 0.01); // 1%
      const gst = Math.round(baseAmount * 0.18); // 18% GST
      const totalAmount = baseAmount + convenienceFee + gst;

      // Keep `amount` as the final payable amount for the existing webhook/status flow.
      const amount = totalAmount;

      if (
        !Number.isSafeInteger(baseAmount) ||
        !Number.isSafeInteger(convenienceFee) ||
        !Number.isSafeInteger(gst) ||
        !Number.isSafeInteger(totalAmount) ||
        totalAmount <= 0
      ) {
        throw paymentError(
          "Invalid course payment amount",
          400
        );
      }

      // --------------------------------------------------------
      // Currency
      // --------------------------------------------------------

      const currency = String(
        product.currency || ""
      )
        .trim()
        .toLowerCase();

      if (!/^[a-z]{3}$/.test(currency)) {
        throw paymentError(
          "Course currency is invalid",
          409
        );
      }

      // --------------------------------------------------------
      // Stripe client
      // --------------------------------------------------------

      const stripeApi = stripeClient(req);

      // One active checkout per user/course
      const activeKey =
        `${req.user._id}:${product._id}`;

      let payment =
        await Payment.findOne({
          activeKey,
        });

      // --------------------------------------------------------
      // Reuse existing Checkout session
      // --------------------------------------------------------

      if (payment) {
        const reusable =
          await getReusableSession(
            stripeApi,
            payment
          );

        if (reusable) {
          return res.json({
            success: true,
            data: {
              sessionId: reusable.id,
              url: reusable.url,
            },
          });
        }
      }

      // --------------------------------------------------------
      // Create Payment record
      // --------------------------------------------------------

      try {
        payment = await Payment.create({
          user: req.user._id,
          product: product._id,
          // Existing amount field now represents the final Stripe charge.
          amount: totalAmount,
          baseAmount,
          convenienceFee,
          gst,
          totalAmount,
          currency,
          activeKey,
        });
      } catch (error) {
        // Duplicate activeKey
        if (error?.code !== 11000) {
          throw error;
        }

        payment =
          await Payment.findOne({
            activeKey,
          });

        if (!payment) {
          throw error;
        }

        const reusable =
          await getReusableSession(
            stripeApi,
            payment
          );

        if (reusable) {
          return res.json({
            success: true,
            data: {
              sessionId: reusable.id,
              url: reusable.url,
            },
          });
        }
      }

      // --------------------------------------------------------
      // Redirect URLs
      // --------------------------------------------------------

      const {
        successUrl,
        cancelUrl,
      } = checkoutUrls(product._id);

      // --------------------------------------------------------
      // Stripe metadata
      // --------------------------------------------------------

      const metadata = {
        userId:
          req.user._id.toString(),

        courseId:
          product._id.toString(),

        paymentId:
          payment._id.toString(),

        // Stripe metadata values must be strings.
        baseAmount: String(baseAmount),
        convenienceFee: String(convenienceFee),
        gst: String(gst),
        totalAmount: String(totalAmount),
      };

      // --------------------------------------------------------
      // Create Stripe Checkout Session
      // --------------------------------------------------------

const session =
  await stripeApi.checkout.sessions.create({
    mode: "payment",

    payment_method_types: ["card"],

    customer_email: req.user.email,

    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: totalAmount,

          product_data: {
            name: String(
              product.title || "Course"
            ).slice(0, 127),

            metadata: {
              courseId: product._id.toString(),
            },
          },
        },
      },
    ],

    metadata,

    payment_intent_data: {
      metadata,
    },

    success_url: successUrl,
    cancel_url: cancelUrl,
  });

      // --------------------------------------------------------
      // Save Stripe Checkout ID
      // --------------------------------------------------------

      payment.checkoutSessionId =
        session.id;

      await payment.save();

      return res.status(201).json({
        success: true,

        data: {
          sessionId:
            session.id,

          url:
            session.url,

          // Major-unit values for frontend display.
          baseAmount: baseAmount / 100,
          convenienceFee: convenienceFee / 100,
          gst: gst / 100,
          totalAmount: totalAmount / 100,
          currency,
        },
      });
    } catch (error) {
      console.error(
        "Stripe checkout error:",
        error
      );

      return sendApiError(
        res,
        error,
        {
          fallbackMessage:
            "Unable to start payment",
        }
      );
    }
  }
);

// ============================================================
// CHECK PAYMENT / ENROLLMENT STATUS
// ============================================================

router.get(
  "/session/:sessionId/status",
  requireAuth,
  async (req, res) => {
    try {
      const sessionId = String(
        req.params.sessionId || ""
      ).trim();

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message:
            "Payment session ID is required",
        });
      }

      const payment =
        await Payment.findOne({
          checkoutSessionId:
            sessionId,

          user:
            req.user._id,
        });

      if (!payment) {
        return res.status(404).json({
          success: false,
          message:
            "Payment session not found",
        });
      }

      const enrollment =
        await Enrollment.findOne({
          user:
            req.user._id,

          product:
            payment.product,

          status: {
            $ne: "cancelled",
          },
        });

      return res.json({
        success: true,

        data: {
          sessionId:
            payment.checkoutSessionId,

          courseId:
            payment.product.toString(),

          paymentStatus:
            payment.paymentStatus,

          enrollmentStatus:
            payment.enrollmentStatus,

          enrolled:
            Boolean(enrollment),
        },
      });
    } catch (error) {
      console.error(
        "Payment status error:",
        error
      );

      return sendApiError(
        res,
        error,
        {
          fallbackMessage:
            "Unable to check payment status",
        }
      );
    }
  }
);

// ============================================================
// COMPLETE CHECKOUT
// ============================================================

async function completeCheckout(
  session,
  eventId
) {
  if (
    !session ||
    session.payment_status !== "paid"
  ) {
    return;
  }

  const {
    userId,
    courseId,
    paymentId,
  } = session.metadata || {};

  const validMetadata =
    [userId, courseId, paymentId].every(
      (value) =>
        mongoose.isValidObjectId(value)
    );

  if (!validMetadata) {
    throw paymentError(
      "Stripe session metadata is invalid",
      400
    );
  }

  const databaseSession =
    await mongoose.startSession();

  try {
    await databaseSession.withTransaction(
      async () => {
        const payment =
          await Payment.findOne({
            _id:
              paymentId,

            checkoutSessionId:
              session.id,
          }).session(databaseSession);

        if (!payment) {
          throw paymentError(
            "Payment record not found",
            404
          );
        }

        if (
          payment.user.toString() !==
            userId ||
          payment.product.toString() !==
            courseId
        ) {
          throw paymentError(
            "Stripe session metadata does not match the payment",
            400
          );
        }

        // ------------------------------------------------------
        // Verify amount
        // ------------------------------------------------------

        if (
          payment.amount !==
            session.amount_total ||
          payment.currency !==
            String(
              session.currency || ""
            ).toLowerCase()
        ) {
          throw paymentError(
            "Stripe payment amount does not match the course price",
            400
          );
        }

        // ------------------------------------------------------
        // Find / create enrollment
        // ------------------------------------------------------

        let enrollment =
          await Enrollment.findOne({
            user:
              payment.user,

            product:
              payment.product,
          }).session(databaseSession);

        if (!enrollment) {
          [enrollment] =
            await Enrollment.create(
              [
                {
                  user:
                    payment.user,

                  product:
                    payment.product,
                },
              ],
              {
                session:
                  databaseSession,
              }
            );

          await Product.updateOne(
            {
              _id:
                payment.product,
            },
            {
              $inc: {
                enrollmentCount: 1,
              },
            },
            {
              session:
                databaseSession,
            }
          );
        }

        // ------------------------------------------------------
        // Mark payment completed
        // ------------------------------------------------------

        payment.paymentIntentId =
          typeof session.payment_intent ===
          "string"
            ? session.payment_intent
            : session.payment_intent?.id;

        payment.paymentStatus =
          "paid";

        payment.enrollmentStatus =
          "completed";

        if (!payment.paidAt) {
          payment.paidAt =
            new Date(
              (
                session.created ||
                Math.floor(
                  Date.now() / 1000
                )
              ) * 1000
            );
        }

        payment.lastWebhookEventId =
          eventId;

        // Allow future Payment records
        // after this transaction is completed.
        payment.activeKey =
          undefined;

        await payment.save({
          session:
            databaseSession,
        });

        // Enrollment is complete here: credit referral rewards once, then convenience fee.
        await creditEnrollmentReferralRewards(payment, enrollment, databaseSession);
        await creditConvenienceFee(payment, databaseSession);
      }
    );
  } finally {
    await databaseSession.endSession();
  }
}

// ============================================================
// STRIPE WEBHOOK
// ============================================================

async function stripeWebhook(req, res) {
  let event;

  try {
    if (!STRIPE_WEBHOOK_SECRET) {
      throw paymentError(
        "Stripe webhook is not configured",
        503
      );
    }

    const stripeApi =
      stripeClient(req);

    event =
      stripeApi.webhooks.constructEvent(
        req.body,
        req.headers[
          "stripe-signature"
        ],
        STRIPE_WEBHOOK_SECRET
      );
  } catch (error) {
    console.error(
      "Stripe webhook verification failed:",
      error.message
    );

    return res
      .status(
        error.statusCode || 400
      )
      .json({
        success: false,

        message:
          error.statusCode === 503
            ? error.message
            : "Invalid Stripe webhook signature",
      });
  }

  try {
    const checkout =
      event.data.object;

    // ----------------------------------------------------------
    // Successful payment
    // ----------------------------------------------------------

    if (
      [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ].includes(event.type)
    ) {
      await completeCheckout(
        checkout,
        event.id
      );
    }

    // ----------------------------------------------------------
    // Failed / expired Checkout
    // ----------------------------------------------------------

    else if (
      [
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
      ].includes(event.type)
    ) {
      await Payment.updateOne(
        {
          checkoutSessionId:
            checkout.id,

          paymentStatus: {
            $ne: "paid",
          },
        },
        {
          $set: {
            paymentStatus:
              event.type ===
              "checkout.session.expired"
                ? "expired"
                : "failed",

            enrollmentStatus:
              "not_created",

            lastWebhookEventId:
              event.id,
          },

          $unset: {
            activeKey: 1,
          },
        }
      );
    }

    return res.json({
      received: true,
    });
  } catch (error) {
    console.error(
      "Stripe webhook processing failed:",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,
        message:
          "Unable to process Stripe webhook",
      });
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  paymentRouter: router,
  stripeWebhook,
};