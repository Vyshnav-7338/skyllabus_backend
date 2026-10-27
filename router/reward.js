const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Reward = require("../models/Reward");
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

async function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => req.user.role === "admin" ? next() : res.status(403).json({ success: false, message: "Admin access required" }));
}

router.get("/my", requireAuth, async (req, res) => {
  try {
    const rewards = await Reward.find({ user: req.user._id }).sort({ createdAt: -1 });
    return res.json({ success: true, data: rewards });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load rewards" });
  }
});

router.get("/", requireAdmin, async (_req, res) => {
  try {
    const rewards = await Reward.find().populate("user", "name email phone").sort({ createdAt: -1 });
    return res.json({ success: true, data: rewards });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load rewards" });
  }
});

router.post("/", requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body.userId || "");
    const title = String(req.body.title || "").trim();
    const type = String(req.body.type || "").trim();
    if (!mongoose.isValidObjectId(userId) || !(await User.exists({ _id: userId }))) return res.status(400).json({ success: false, message: "Valid user is required" });
    if (!title || !type) return res.status(400).json({ success: false, message: "Reward title and type are required" });
    const reward = await Reward.create({ user: userId, title, type, description: String(req.body.description || "").trim(), points: Number(req.body.points || 0), source: String(req.body.source || "").trim() });
    await reward.populate("user", "name email phone");
    return res.status(201).json({ success: true, message: "Reward created successfully", data: reward });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to create reward" });
  }
});

router.put("/:id", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid reward ID" });
    const reward = await Reward.findById(req.params.id);
    if (!reward) return res.status(404).json({ success: false, message: "Reward not found" });
    for (const field of ["type", "title", "description", "source"]) if (req.body[field] !== undefined) reward[field] = String(req.body[field]).trim();
    if (req.body.points !== undefined) reward.points = Number(req.body.points);
    await reward.save();
    await reward.populate("user", "name email phone");
    return res.json({ success: true, message: "Reward updated successfully", data: reward });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to update reward" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid reward ID" });
    const reward = await Reward.findByIdAndDelete(req.params.id);
    if (!reward) return res.status(404).json({ success: false, message: "Reward not found" });
    return res.json({ success: true, message: "Reward deleted successfully", data: reward });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to delete reward" });
  }
});

module.exports = router;
