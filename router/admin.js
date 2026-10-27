const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Category = require("../models/Category");
const Product = require("../models/Product");
const Enrollment = require("../models/Enrollment");
const Giveaway = require("../models/Giveaway");
const Reward = require("../models/Reward");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const ReferralSettings = require("../models/ReferralSettings");
const { normalizeMoney } = require("../utils/money");
const { sendApiError } = require("../utils/api-error");

const adminRouter = express.Router();
const usersRouter = express.Router();
JWT_SECRET='local-development-secret-change-before-production'

async function requireAdmin(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return res.status(401).json({ success: false, message: "Authentication required" });
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ success: false, message: "User no longer exists" });
    if (user.role !== "admin") return res.status(403).json({ success: false, message: "Admin access required" });
    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

function toBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === true || value === "true" || value === "1" || value === 1;
}

adminRouter.get("/stats", requireAdmin, async (_req, res) => {
  try {
    const [categories, products, productContent, users, enrollments, giveaways, rewards] = await Promise.all([
      Category.countDocuments(), Product.countDocuments(), Product.find().select("courseVideo modules").lean(), User.countDocuments(),
      Enrollment.countDocuments(), Giveaway.countDocuments(), Reward.countDocuments(),
    ]);
    const videos = productContent.reduce((total, product) => total + (product.courseVideo ? 1 : 0), 0);
    return res.json({ success: true, data: { categories, products, videos, users, enrollments, giveaways, rewards } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load dashboard statistics" });
  }
});

adminRouter.get("/enrollments", requireAdmin, async (_req, res) => {
  try {
    const enrollments = await Enrollment.find()
      .populate("user", "name email phone")
      .populate("product", "title")
      .sort({ enrolledAt: -1 });
    return res.json({ success: true, data: enrollments });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load enrollments" });
  }
});

adminRouter.get("/referral-settings", requireAdmin, async (_req, res) => {
  try {
    const settings = await ReferralSettings.findOneAndUpdate(
      { key: "default" },
      { $setOnInsert: { key: "default" } },
      { returnDocument: "after", upsert: true, runValidators: true },
    );
    return res.json({ success: true, data: settings });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load referral settings" });
  }
});

adminRouter.put("/referral-settings", requireAdmin, async (req, res) => {
  try {
    const update = { isActive: toBoolean(req.body.isActive) };
    for (let level = 1; level <= 5; level += 1) {
      const field = `level${level}Reward`;
      const value = Number(req.body[field]);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ success: false, message: `${field} must be zero or greater` });
      }
      update[field] = normalizeMoney(value);
    }
    const settings = await ReferralSettings.findOneAndUpdate(
      { key: "default" },
      { $set: update, $setOnInsert: { key: "default" } },
      { returnDocument: "after", upsert: true, runValidators: true },
    );
    if (!settings?._id) throw new Error("Referral settings update completed without a persisted record");
    const persisted = await ReferralSettings.findById(settings._id);
    if (!persisted?._id) throw new Error("Referral settings could not be read back after save");
    return res.json({ success: true, message: "Referral settings updated", data: persisted });
  } catch (error) {
    return sendApiError(res, error, {
      duplicateMessage: "Referral settings already exist",
      fallbackMessage: "Unable to update referral settings",
    });
  }
});

adminRouter.get("/referral-overview", requireAdmin, async (_req, res) => {
  try {
    const [totalReferralUsers, referralTotals, walletTotals, recentTransactions] = await Promise.all([
      User.countDocuments({ referredBy: { $ne: null } }),
      WalletTransaction.aggregate([
        { $match: { transactionType: "REFERRAL_REWARD", type: "CREDIT" } },
        { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
      Wallet.aggregate([{
        $group: {
          _id: null,
          availableBalance: { $sum: "$availableBalance" },
          totalCredits: { $sum: "$totalCredits" },
          totalDebits: { $sum: "$totalDebits" },
        },
      }]),
      WalletTransaction.find({ transactionType: "REFERRAL_REWARD" })
        .populate("user", "name email")
        .populate("referredUser", "name referralCode")
        .sort({ createdAt: -1 })
        .limit(20),
    ]);
    return res.json({
      success: true,
      data: {
        totalReferralUsers,
        totalReferralRewards: referralTotals[0]?.amount || 0,
        referralTransactions: referralTotals[0]?.count || 0,
        availableBalance: walletTotals[0]?.availableBalance || 0,
        totalCredits: walletTotals[0]?.totalCredits || 0,
        totalDebits: walletTotals[0]?.totalDebits || 0,
        recentTransactions,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load referral overview" });
  }
});

usersRouter.get("/", requireAdmin, async (_req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    return res.json({ success: true, data: users });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load users" });
  }
});

module.exports = { adminRouter, usersRouter };
