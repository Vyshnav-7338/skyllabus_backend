const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Giveaway = require("../models/Giveaway");
const GiveawayEntry = require("../models/GiveawayEntry");
const futils = require("../utils/fileutils");
const { imageUpload } = require("../utils/media-upload");
const { removeIfUnreferenced } = require("../utils/media-references");
JWT_SECRET='local-development-secret-change-before-production'

const router = express.Router();

function toBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === true || value === "true" || value === "1" || value === 1;
}

async function authenticate(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const payload = jwt.verify(header.slice(7), JWT_SECRET);
  return User.findById(payload.id);
}

async function requireAuth(req, res, next) {
  try {
    const user = await authenticate(req);
    if (!user || user.status === "disabled") return res.status(401).json({ success: false, message: "Authentication required" });
    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

async function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => req.user.role === "admin" ? next() : res.status(403).json({ success: false, message: "Admin access required" }));
}

router.get("/", async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    if (includeInactive) {
      return requireAdmin(req, res, async () => {
        const giveaways = await Giveaway.find().sort({ startDate: -1 });
        return res.json({ success: true, data: giveaways });
      });
    }
    const now = new Date();
    const giveaways = await Giveaway.find({ isActive: true, startDate: { $lte: now }, endDate: { $gte: now } }).sort({ endDate: 1 });
    return res.json({ success: true, data: giveaways });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load giveaways" });
  }
});

router.get("/:id/my-entry", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid giveaway ID" });
    const entry = await GiveawayEntry.findOne({ giveaway: req.params.id, user: req.user._id });
    return res.json({ success: true, data: { joined: Boolean(entry), entry } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load giveaway entry" });
  }
});

router.get("/:id/participants", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid giveaway ID" });
    const entries = await GiveawayEntry.find({ giveaway: req.params.id }).populate("user", "name email phone referralCode").sort({ joinedAt: -1 });
    return res.json({ success: true, data: entries });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load participants" });
  }
});

router.post("/:id/join", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid giveaway ID" });
    const now = new Date();
    const giveaway = await Giveaway.findOne({ _id: req.params.id, isActive: true, startDate: { $lte: now }, endDate: { $gte: now } });
    if (!giveaway) return res.status(404).json({ success: false, message: "Active giveaway not found" });
    const existing = await GiveawayEntry.findOne({ giveaway: giveaway._id, user: req.user._id });
    if (existing) return res.status(409).json({ success: false, message: "You already joined this giveaway", data: existing });
    const entry = await GiveawayEntry.create({ giveaway: giveaway._id, user: req.user._id });
    giveaway.currentParticipants = await GiveawayEntry.countDocuments({ giveaway: giveaway._id, status: "joined" });
    await giveaway.save();
    return res.status(201).json({ success: true, message: "Giveaway joined successfully", data: entry });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ success: false, message: "You already joined this giveaway" });
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to join giveaway" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid giveaway ID" });
    const giveaway = await Giveaway.findOne({ _id: req.params.id, isActive: true });
    if (!giveaway) return res.status(404).json({ success: false, message: "Giveaway not found" });
    return res.json({ success: true, data: giveaway });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load giveaway" });
  }
});

router.post("/", requireAdmin, imageUpload, async (req, res) => {
  let uploaded;
  try {
    const { title, description, reward, startDate, endDate } = req.body;
    const target = Number(req.body.target);
    if (!title || !description || !reward || !startDate || !endDate || !Number.isFinite(target) || target < 1) return res.status(400).json({ success: false, message: "Title, description, reward, dates, and target are required" });
    if (new Date(endDate) <= new Date(startDate)) return res.status(400).json({ success: false, message: "End date must be after start date" });
    uploaded = req.file ? await futils.getFileObject(req.file) : null;
    const giveaway = await Giveaway.create({ title, description, reward, startDate, endDate, target, image: uploaded, isActive: toBoolean(req.body.isActive, true) });
    return res.status(201).json({ success: true, message: "Giveaway created successfully", data: giveaway });
  } catch (error) {
    if (uploaded) await futils.removeFileObject(uploaded);
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to create giveaway" });
  } finally { await futils.removeIncoming(req.file ? [req.file] : []); }
});

router.put("/:id", requireAdmin, imageUpload, async (req, res) => {
  let uploaded;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid giveaway ID" });
    const giveaway = await Giveaway.findById(req.params.id);
    if (!giveaway) return res.status(404).json({ success: false, message: "Giveaway not found" });
    for (const field of ["title", "description", "reward"]) if (req.body[field] !== undefined) giveaway[field] = String(req.body[field]).trim();
    const oldImage = giveaway.image?.toObject?.() || giveaway.image;
    if (req.file) {
      uploaded = await futils.getFileObject(req.file);
      giveaway.image = uploaded;
    }
    for (const field of ["startDate", "endDate"]) if (req.body[field] !== undefined) giveaway[field] = new Date(req.body[field]);
    if (req.body.target !== undefined) giveaway.target = Number(req.body.target);
    if (req.body.isActive !== undefined) giveaway.isActive = toBoolean(req.body.isActive);
    if (giveaway.endDate <= giveaway.startDate) return res.status(400).json({ success: false, message: "End date must be after start date" });
    await giveaway.save();
    if (uploaded && oldImage) await removeIfUnreferenced(oldImage);
    return res.json({ success: true, message: "Giveaway updated successfully", data: giveaway });
  } catch (error) {
    if (uploaded) await futils.removeFileObject(uploaded);
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to update giveaway" });
  } finally { await futils.removeIncoming(req.file ? [req.file] : []); }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid giveaway ID" });
    const giveaway = await Giveaway.findByIdAndDelete(req.params.id);
    if (!giveaway) return res.status(404).json({ success: false, message: "Giveaway not found" });
    await GiveawayEntry.deleteMany({ giveaway: giveaway._id });
    if (giveaway.image) await removeIfUnreferenced(giveaway.image);
    return res.json({ success: true, message: "Giveaway deleted successfully", data: giveaway });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to delete giveaway" });
  }
});

module.exports = router;
