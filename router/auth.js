const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const ReferralSettings = require("../models/ReferralSettings");
const ReferralCommission = require("../models/ReferralCommission");
const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const { sendApiError } = require("../utils/api-error");

const router = express.Router();

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+[1-9]\d{7,14}$/;

function signToken(user) {
  return jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

async function generateReferralCode(name, session) {
  const prefix = String(name || "USER").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4).padEnd(4, "X");
  let code;
  let exists = true;
  while (exists) {
    code = `SKY${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
    exists = await User.exists({ referralCode: code }).session(session || null);
  }
  return code;
}

function signupError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function creditReferralUplines(newUser, directReferrer, session) {
  const settings = await ReferralSettings.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { returnDocument: "after", upsert: true, runValidators: true, session },
  );
  if (!settings?.isActive || !directReferrer) return;

  const visited = new Set([newUser._id.toString()]);
  let upline = directReferrer;
  for (let level = 1; level <= 5 && upline; level += 1) {
    const uplineId = upline._id.toString();
    if (visited.has(uplineId)) throw signupError("Invalid referral hierarchy", 409);
    visited.add(uplineId);

    const amountInMinorUnits = toMinorUnits(settings[`level${level}Reward`] || 0);
    if (amountInMinorUnits > 0) {
      let wallet = await Wallet.findOne({ user: upline._id }).session(session);
      if (!wallet) {
        [wallet] = await Wallet.create([{ user: upline._id }], { session });
      }
      const balanceBeforeInMinorUnits = toMinorUnits(wallet.availableBalance);
      wallet.availableBalance = fromMinorUnits(balanceBeforeInMinorUnits + amountInMinorUnits);
      wallet.totalCredits = fromMinorUnits(toMinorUnits(wallet.totalCredits) + amountInMinorUnits);
      await wallet.save({ session });
      await WalletTransaction.create([{
        user: upline._id,
        type: "CREDIT",
        transactionType: "REFERRAL_REWARD",
        amount: fromMinorUnits(amountInMinorUnits),
        referralLevel: level,
        referredUser: newUser._id,
        balanceBefore: fromMinorUnits(balanceBeforeInMinorUnits),
        balanceAfter: wallet.availableBalance,
        description: `Level ${level} referral signup reward`,
        reference: newUser.referralCode,
        eventKey: `SIGNUP:${newUser._id}:UPLINE:${upline._id}:LEVEL:${level}`,
      }], { session });
      await ReferralCommission.create([{
        beneficiary: upline._id,
        sourceUser: newUser._id,
        level,
        amount: fromMinorUnits(amountInMinorUnits),
        triggerType: "signup",
        status: "credited",
      }], { session });
    }

    upline = upline.referredBy
      ? await User.findById(upline.referredBy).session(session)
      : null;
  }
}

router.post("/signup", async (req, res) => {
  let session;
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").replace(/\s+/g, "");
    const password = String(req.body.password || "");
    const suppliedReferral = String(req.body.referralCode || "").replace(/\s+/g, "").toUpperCase();

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: "Name, email, phone, and password are required" });
    }
    if (!emailPattern.test(email)) {
      return res.status(400).json({ success: false, message: "Enter a valid email address" });
    }
    if (!phonePattern.test(phone)) {
      return res.status(400).json({ success: false, message: "Phone must include a valid country code" });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }
    if (await User.exists({ email })) {
      return res.status(409).json({ success: false, message: "An account already exists with this email" });
    }
    if (await User.exists({ phone })) {
      return res.status(409).json({ success: false, message: "An account already exists with this phone number" });
    }

    session = await mongoose.startSession();
    let user;
    await session.withTransaction(async () => {
      let referrer = null;
      if (suppliedReferral) {
        referrer = await User.findOne({
          referralCode: suppliedReferral,
          status: { $ne: "disabled" },
        }).session(session);
        if (!referrer) throw signupError("Referral code is invalid");
        if (referrer.email === email || referrer.phone === phone) throw signupError("You cannot refer yourself");
      }

      [user] = await User.create([{
        name,
        email,
        phone,
        password,
        referralCode: await generateReferralCode(name, session),
        referredBy: referrer?._id || null,
      }], { session });
      await Wallet.create([{ user: user._id }], { session });
      await creditReferralUplines(user, referrer, session);
    });

    const [persistedUser, persistedWallet] = await Promise.all([
      User.findById(user._id),
      Wallet.findOne({ user: user._id }),
    ]);
    if (!persistedUser?._id || !persistedWallet?._id) {
      throw new Error("Signup transaction committed without the required user and wallet records");
    }

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      token: signToken(persistedUser),
      user: persistedUser.toJSON(),
    });
  } catch (error) {
    return sendApiError(res, error, {
      duplicateMessage: "Email, phone, or referral code already exists",
      fallbackMessage: "Unable to create account",
    });
  } finally {
    if (session) await session.endSession();
  }
});

router.post("/login", async (req, res) => {
  try {
    console.log("Login request body:", req.body);
    const identifier = String(req.body.email || req.body.phone || "").trim();
    console.log("Login attempt with identifier:", identifier);
    const password = String(req.body.password || "");
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Email or phone and password are required" });
    }
    const query = identifier.includes("@")
      ? { email: identifier.toLowerCase() }
      : { phone: identifier.replace(/\s+/g, "") };
    const user = await User.findOne(query).select("+password");
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: "Invalid login credentials" });
    }
    if (user.status === "disabled") {
      return res.status(403).json({ success: false, message: "This account is disabled" });
    }
    const safeUser = user.toObject();
    delete safeUser.password;
    delete safeUser.__v;
    return res.json({
      success: true,
      message: "Login successful",
      token: signToken(user),
      user: safeUser,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to login" });
  }
});

module.exports = router;
