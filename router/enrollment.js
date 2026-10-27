const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Product = require("../models/Product");
const Enrollment = require("../models/Enrollment");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const { sendApiError } = require("../utils/api-error");

const router = express.Router();
JWT_SECRET='local-development-secret-change-before-production'

async function requireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return res.status(401).json({ success: false, message: "Authentication required" });
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user || user.status === "disabled") return res.status(401).json({ success: false, message: "User is unavailable" });
    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

function enrollmentError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function enrollWithWallet(req, res) {
  let session;
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    session = await mongoose.startSession();
    let enrollmentId;
    let walletId;
    await session.withTransaction(async () => {
      const product = await Product.findOne({
        _id: req.params.productId,
        isPublished: true,
        isActive: { $ne: false },
      }).session(session);
      if (!product) throw enrollmentError("Product not found or unavailable", 404);

      const existing = await Enrollment.findOne({ user: req.user._id, product: product._id }).session(session);
      if (existing) throw enrollmentError("You are already enrolled in this course", 409);

      let wallet = await Wallet.findOne({ user: req.user._id }).session(session);
      if (!wallet) [wallet] = await Wallet.create([{ user: req.user._id }], { session });
      const payablePrice = product.offerPrice > 0 ? product.offerPrice : product.price;
      const amountInMinorUnits = toMinorUnits(payablePrice);
      if (!Number.isFinite(amountInMinorUnits) || amountInMinorUnits < 0) throw enrollmentError("Product price is invalid", 409);
      if (amountInMinorUnits > 0) throw enrollmentError("Payment is required to enroll in this course", 402);
      const balanceBeforeInMinorUnits = toMinorUnits(wallet.availableBalance);
      if (balanceBeforeInMinorUnits < amountInMinorUnits) throw enrollmentError("Insufficient wallet balance", 400);

      wallet.availableBalance = fromMinorUnits(balanceBeforeInMinorUnits - amountInMinorUnits);
      wallet.totalDebits = fromMinorUnits(toMinorUnits(wallet.totalDebits) + amountInMinorUnits);
      await wallet.save({ session });

      let enrollment;
      [enrollment] = await Enrollment.create([{ user: req.user._id, product: product._id }], { session });
      await WalletTransaction.create([{
        user: req.user._id,
        type: "DEBIT",
        transactionType: "COURSE_ENROLLMENT",
        amount: fromMinorUnits(amountInMinorUnits),
        product: product._id,
        balanceBefore: fromMinorUnits(balanceBeforeInMinorUnits),
        balanceAfter: wallet.availableBalance,
        description: `Course enrollment: ${product.title}`,
        reference: product._id.toString(),
        eventKey: `ENROLLMENT:${req.user._id}:PRODUCT:${product._id}`,
      }], { session });
      product.enrollmentCount += 1;
      await product.save({ session });
      enrollmentId = enrollment._id;
      walletId = wallet._id;
    });

    const enrollment = await Enrollment.findById(enrollmentId);
    if (!enrollment?._id) throw new Error("Enrollment transaction committed without an enrollment record");
    await enrollment.populate({ path: "product", populate: { path: "category" } });
    const [wallet, debit] = await Promise.all([
      Wallet.findById(walletId),
      WalletTransaction.findOne({
        user: req.user._id,
        product: req.params.productId,
        transactionType: "COURSE_ENROLLMENT",
      }),
    ]);
    if (!wallet?._id || !debit?._id) {
      throw new Error("Enrollment transaction committed without the required wallet and debit records");
    }
    return res.status(201).json({
      success: true,
      message: "Course enrolled successfully",
      data: { enrollment, wallet },
    });
  } catch (error) {
    return sendApiError(res, error, {
      duplicateMessage: "You are already enrolled in this course",
      fallbackMessage: "Unable to enroll in course",
    });
  } finally {
    if (session) await session.endSession();
  }
}

router.post("/:productId", requireAuth, enrollWithWallet);
router.post("/:productId/enroll", requireAuth, enrollWithWallet);

router.get("/my", requireAuth, async (req, res) => {
  try {
    const enrollments = await Enrollment.find({ user: req.user._id })
      .populate({ path: "product", populate: { path: "category" } })
      .sort({ lastAccessedAt: -1, enrolledAt: -1 });
    return res.json({ success: true, data: enrollments });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load enrollments" });
  }
});

router.get("/check/:productId", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    const enrollment = await Enrollment.findOne({ user: req.user._id, product: req.params.productId });
    return res.json({ success: true, data: { enrolled: Boolean(enrollment), enrollment } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to check enrollment" });
  }
});

router.get("/:productId/progress", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    const enrollment = await Enrollment.findOne({ user: req.user._id, product: req.params.productId });
    if (!enrollment) return res.status(404).json({ success: false, message: "Enrollment not found" });
    return res.json({ success: true, data: enrollment });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load course progress" });
  }
});

router.put("/:productId/progress", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    const progress = Number(req.body.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) return res.status(400).json({ success: false, message: "Progress must be between 0 and 100" });
    const enrollment = await Enrollment.findOne({ user: req.user._id, product: req.params.productId });
    if (!enrollment) return res.status(404).json({ success: false, message: "Enrollment not found" });
    enrollment.progress = Math.round(progress);
    enrollment.lastAccessedAt = new Date();
    enrollment.completed = progress >= 100;
    enrollment.status = enrollment.completed ? "completed" : "active";
    enrollment.completedAt = enrollment.completed ? enrollment.completedAt || new Date() : null;
    await enrollment.save();
    return res.json({ success: true, message: "Course progress updated", data: enrollment });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to update course progress" });
  }
});

module.exports = router;
