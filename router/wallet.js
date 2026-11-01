const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const WithdrawalRequest = require("../models/WithdrawalRequest");
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

router.get("/payout-details", requireAuth, async (req, res) => {
  const details = req.user.payoutDetails || null;
  return res.json({ success: true, data: details });
});

router.put("/payout-details", requireAuth, async (req, res) => {
  try {
    const method = String(req.body.method || "").toUpperCase();
    if (!["UPI", "BANK"].includes(method)) return res.status(400).json({ success: false, message: "Choose UPI or Bank Account" });
    const details = { method, updatedAt: new Date() };
    if (method === "UPI") {
      const upiId = String(req.body.upiId || "").trim();
      if (!upiId.includes("@")) return res.status(400).json({ success: false, message: "Enter a valid UPI ID" });
      details.upiId = upiId;
    } else {
      details.accountHolderName = String(req.body.accountHolderName || "").trim();
      details.accountNumber = String(req.body.accountNumber || "").trim();
      details.ifscCode = String(req.body.ifscCode || "").trim().toUpperCase();
      details.bankName = String(req.body.bankName || "").trim();
      if (!details.accountHolderName || !details.accountNumber || !details.ifscCode || !details.bankName)
        return res.status(400).json({ success: false, message: "Complete all bank details" });
    }
    req.user.payoutDetails = details;
    await req.user.save();
    return res.json({ success: true, message: "Payout details saved", data: req.user.payoutDetails });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to save payout details" });
  }
});

router.post("/withdraw", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 1000)
      return res.status(400).json({ success: false, message: "Minimum withdrawal is ₹1,000" });
    const wallet = await Wallet.findOne({ user: req.user._id });
    if (!wallet || wallet.availableBalance < amount)
      return res.status(400).json({ success: false, message: "Insufficient wallet balance" });
    const details = req.user.payoutDetails;
    if (!details || !details.method)
      return res.status(400).json({ success: false, message: "Add payout details first" });
    const request = await WithdrawalRequest.create({
      user: req.user._id, amount, method: details.method,
      payoutDetails: {
        upiId: details.upiId || "", accountHolderName: details.accountHolderName || "",
        accountNumber: details.accountNumber || "", ifscCode: details.ifscCode || "", bankName: details.bankName || ""
      }
    });
    return res.status(201).json({ success: true, message: "Withdrawal request submitted", data: request });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to submit withdrawal request" });
  }
});

module.exports = router;
