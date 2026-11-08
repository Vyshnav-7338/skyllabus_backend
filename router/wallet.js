const express = require("express");
const mongoose = require("mongoose");
const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const JWT_SECRET = process.env.JWT_SECRET;

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

// Wallet-to-wallet transfers require MongoDB replica-set transactions.
const FEE_EMAIL = "minhajmuhammed999@gmail.com";
router.post("/transfer", requireAuth, async (req, res) => {
  const amountMinor = toMinorUnits(req.body.amount);
  const code = String(req.body.referralCode || "").trim().toUpperCase();
  const transferId = String(req.body.transferId || "").trim();
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 50000 || amountMinor > 1000000000)
    return res.status(400).json({ success: false, message: "Minimum transfer is ₹500" });
  if (!code || !/^[a-zA-Z0-9_-]{4,64}$/.test(transferId))
    return res.status(400).json({ success: false, message: "Valid recipient code and transfer ID required" });
  const amount = fromMinorUnits(amountMinor);
  const fee = fromMinorUnits(Math.round(amountMinor * 5 / 100));
  const net = fromMinorUnits(amountMinor - Math.round(amountMinor * 5 / 100));
  const key = `WALLET_TRANSFER:${req.user._id}:${transferId}`;
  let session;
  try {
    const prior = await WalletTransaction.findOne({ eventKey: `${key}:SENDER` });
    if (prior) return res.json({ success: true, message: "Transfer already completed", data: { amount, fee, received: net, transferId } });
    const [recipient, feeUser] = await Promise.all([
      User.findOne({ referralCode: code, status: { $ne: "disabled" } }),
      User.findOne({ email: FEE_EMAIL, status: { $ne: "disabled" } }),
    ]);
    if (!recipient) return res.status(404).json({ success: false, message: "Recipient code not found" });
    if (String(recipient._id) === String(req.user._id)) return res.status(400).json({ success: false, message: "Cannot transfer to yourself" });
    if (!feeUser || [String(req.user._id), String(recipient._id)].includes(String(feeUser._id)))
      return res.status(409).json({ success: false, message: "Fee account unavailable or conflicts with transfer parties" });
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const sender = await Wallet.findOneAndUpdate(
        { user: req.user._id, availableBalance: { $gte: amount } },
        { $inc: { availableBalance: -amount, totalDebits: amount } },
        { new: false, session }
      );
      if (!sender) { const e = new Error("Insufficient wallet balance"); e.status = 400; throw e; }
      const credits = [];
      for (const [user, credit] of [[recipient, net], [feeUser, fee]]) {
        const previous = await Wallet.findOneAndUpdate(
          { user: user._id }, { $inc: { availableBalance: credit, totalCredits: credit }, $setOnInsert: { user: user._id } },
          { upsert: true, new: false, session, setDefaultsOnInsert: true }
        );
        credits.push({ user, credit, before: previous?.availableBalance ?? 0 });
      }
      await WalletTransaction.insertMany([
        { user: req.user._id, type: "DEBIT", transactionType: "WALLET_TRANSFER", amount,
          balanceBefore: sender.availableBalance, balanceAfter: fromMinorUnits(toMinorUnits(sender.availableBalance) - amountMinor),
          description: `Transfer to ${code}`, reference: transferId, eventKey: `${key}:SENDER` },
        ...credits.map(({ user, credit, before }, i) => ({ user: user._id, type: "CREDIT",
          transactionType: i === 0 ? "WALLET_TRANSFER" : "WALLET_TRANSFER_FEE", amount: credit,
          balanceBefore: before, balanceAfter: fromMinorUnits(toMinorUnits(before) + toMinorUnits(credit)),
          description: i === 0 ? "Wallet transfer received" : "Wallet transfer fee received",
          reference: transferId, eventKey: `${key}:${i === 0 ? "RECEIVER" : "FEE"}` }))
      ], { session });
    });
    return res.json({ success: true, message: "Transfer successful", data: { amount, fee, received: net, transferId } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "Transfer already processed; refresh wallet" });
    console.error("Wallet transfer failed", error);
    return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Transfer failed. Please retry with the same transfer ID." });
  } finally { if (session) await session.endSession(); }
});

router.post("/withdraw", requireAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount !== 1000)
      return res.status(400).json({ success: false, message: "Withdrawal amount must be exactly ₹1,000" });
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
