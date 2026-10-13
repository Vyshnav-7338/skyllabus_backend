const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
JWT_SECRET='local-development-secret-change-before-production'

const router = express.Router();

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

async function getWallet(req, res) {
  try {
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { $setOnInsert: { user: req.user._id, availableBalance: 0, totalCredits: 0, totalDebits: 0 } },
      { returnDocument: "after", upsert: true, runValidators: true },
    );
    return res.json({ success: true, data: wallet });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load wallet" });
  }
}

router.get("/", requireAuth, getWallet);
router.get("/me", requireAuth, getWallet);
router.get("/my", requireAuth, getWallet);

router.get("/transactions", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const [transactions, total] = await Promise.all([
      WalletTransaction.find({ user: req.user._id })
        .populate("referredUser", "name referralCode")
        .populate("product", "title")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      WalletTransaction.countDocuments({ user: req.user._id }),
    ]);
    return res.json({ success: true, data: transactions, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load transactions" });
  }
});

module.exports = router;
