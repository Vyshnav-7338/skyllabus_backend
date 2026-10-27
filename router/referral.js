const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const ReferralSettings = require("../models/ReferralSettings");
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

async function levelMemberIds(userId) {
  const levels = [];
  let sponsorIds = [userId];
  for (let level = 1; level <= 5; level += 1) {
    const members = sponsorIds.length
      ? await User.find({ referredBy: { $in: sponsorIds } }).select("_id").lean()
      : [];
    sponsorIds = members.map((member) => member._id);
    levels.push(sponsorIds);
  }
  return levels;
}

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [wallet, levels, earnings, settings] = await Promise.all([
      Wallet.findOneAndUpdate(
        { user: req.user._id },
        { $setOnInsert: { user: req.user._id } },
        { returnDocument: "after", upsert: true, runValidators: true },
      ),
      levelMemberIds(req.user._id),
      WalletTransaction.aggregate([
        { $match: { user: req.user._id, type: "CREDIT", transactionType: "REFERRAL_REWARD" } },
        { $group: { _id: "$referralLevel", total: { $sum: "$amount" } } },
      ]),
      ReferralSettings.findOneAndUpdate(
        { key: "default" },
        { $setOnInsert: { key: "default" } },
        { returnDocument: "after", upsert: true, runValidators: true },
      ),
    ]);
    const earningsByLevel = new Map(earnings.map((item) => [Number(item._id), item.total]));
    const levelSummaries = Array.from({ length: 5 }, (_item, index) => {
      const level = index + 1;
      return {
        level,
        reward: settings[`level${level}Reward`] || 0,
        memberCount: levels[index].length,
        earnings: earningsByLevel.get(level) || 0,
      };
    });
    const totalMembers = levelSummaries.reduce((total, item) => total + item.memberCount, 0);
    const data = {
      referralCode: req.user.referralCode,
      walletBalance: wallet.availableBalance,
      totalMembers,
      totalReferrals: totalMembers,
      totalReferralEarnings: earnings.reduce((total, item) => total + item.total, 0),
      levels: levelSummaries,
    };
    for (let level = 1; level <= 5; level += 1) {
      data[`level${level}Count`] = levels[level - 1].length;
      data[`level${level}Earnings`] = earningsByLevel.get(level) || 0;
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load referral summary" });
  }
});

router.get("/level/:level", requireAuth, async (req, res) => {
  try {
    const level = Number(req.params.level);
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      return res.status(400).json({ success: false, message: "Level must be between 1 and 5" });
    }
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ success: false, message: "Page must be positive and limit must be between 1 and 100" });
    }

    let sponsorIds = [req.user._id];
    for (let depth = 1; depth < level; depth += 1) {
      const members = sponsorIds.length
        ? await User.find({ referredBy: { $in: sponsorIds } }).select("_id").lean()
        : [];
      sponsorIds = members.map((member) => member._id);
    }

    const filter = { referredBy: { $in: sponsorIds } };
    const [members, total] = sponsorIds.length
      ? await Promise.all([
        User.find(filter)
          .select("name createdAt status")
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        User.countDocuments(filter),
      ])
      : [[], 0];

    return res.json({
      success: true,
      data: {
        level,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        members: members.map((member) => ({
          id: member._id,
          name: member.name,
          joinedAt: member.createdAt,
          status: member.status || "active",
        })),
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load referral members" });
  }
});

router.get("/tree", requireAuth, async (req, res) => {
  try {
    const level = Number(req.query.level || 1);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      return res.status(400).json({ success: false, message: "Level must be between 1 and 5" });
    }
    let sponsorIds = [req.user._id];
    for (let depth = 1; depth < level; depth += 1) {
      const members = sponsorIds.length
        ? await User.find({ referredBy: { $in: sponsorIds } }).select("_id").lean()
        : [];
      sponsorIds = members.map((member) => member._id);
    }
    const filter = { referredBy: { $in: sponsorIds } };
    const [members, total] = sponsorIds.length
      ? await Promise.all([
        User.find(filter)
          .select("name referralCode createdAt")
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        User.countDocuments(filter),
      ])
      : [[], 0];
    return res.json({ success: true, data: members, meta: { level, page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load referral members" });
  }
});

module.exports = router;
