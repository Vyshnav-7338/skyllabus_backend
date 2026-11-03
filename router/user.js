const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Product = require("../models/Product");
const Enrollment = require("../models/Enrollment");
const VideoProgress = require("../models/VideoProgress");
const Reward = require("../models/Reward");
const Giveaway = require("../models/Giveaway");
const futils = require("../utils/fileutils");
const { profilePhotoUpload } = require("../utils/media-upload");
const { removeIfUnreferenced } = require("../utils/media-references");
JWT_SECRET='local-development-secret-change-before-production'
const bcrypt = require("bcrypt");

const saltRounds = 10;

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

function levelData(user) {
  const nextLevelXp = Math.max(1, user.nextLevelXp);
  return {
    level: user.level,
    title: `Level ${user.level}`,
    xp: user.xp,
    nextLevelXp,
    nextLevelTitle: `Level ${user.level + 1}`,
    percentage: Math.min(100, Math.round((user.xp / nextLevelXp) * 100)),
  };
}

router.get("/me", requireAuth, async (req, res) => res.json({ success: true, data: req.user }));

router.put("/photo", requireAuth, profilePhotoUpload, async (req, res) => {
  let uploaded;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "Profile photo is required" });
    const oldPhoto = req.user.profilePhoto?.toObject?.() || req.user.profilePhoto;
    uploaded = await futils.getFileObject(req.file);
    req.user.profilePhoto = uploaded;
    await req.user.save();
    if (oldPhoto) await removeIfUnreferenced(oldPhoto);
    return res.json({ success: true, message: "Profile photo updated", data: req.user });
  } catch (error) {
    if (uploaded) await futils.removeFileObject(uploaded);
    return res.status(500).json({ success: false, message: "Unable to update profile photo" });
  } finally {
    await futils.removeIncoming(req.file ? [req.file] : []);
  }
});

router.get("/progress", requireAuth, async (req, res) => {
  return res.json({ success: true, data: levelData(req.user) });
});

router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const [enrolledCourses, completedCourses, videosCompleted, rewards, featuredProducts, activeGiveaway] = await Promise.all([
      Enrollment.countDocuments({ user: req.user._id, status: { $ne: "cancelled" } }),
      Enrollment.countDocuments({ user: req.user._id, completed: true }),
      VideoProgress.countDocuments({ user: req.user._id, completed: true }),
      Reward.countDocuments({ user: req.user._id }),
      Product.find({ isPublished: true, isFeatured: true }).select("-modules").populate("category").sort({ createdAt: -1 }).limit(10),
      Giveaway.findOne({ isActive: true, startDate: { $lte: now }, endDate: { $gte: now } }).sort({ startDate: -1 }),
    ]);
    return res.json({
      success: true,
      data: {
        user: req.user,
        level: levelData(req.user),
        stats: { enrolledCourses, completedCourses, videosCompleted, rewards },
        featuredProducts,
        activeGiveaway,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load dashboard" });
  }
});

router.put("/", async (req, res) => {
  try {
    console.log("CHANGE PASSWORD CALLED");

    const { email, password, security_pass } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    if (!password) {
      return res.status(400).json({
        success: false,
        message: "Password is required"
      });
    }

    if (security_pass !== "n439utb7gt74vg78v3g") {
      return res.status(401).json({
        success: false,
        message: "Request not permitted"
      });
    }

    console.log("Finding user:", email);

    const user = await User.findOne({
      email: email.toLowerCase().trim()
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    console.log("User found");

    const hashedPassword = await bcrypt.hash(password, saltRounds);

    user.password = hashedPassword;

    await user.save();

    console.log("PASSWORD CHANGED SUCCESSFULLY");

    return res.status(200).json({
      success: true,
      message: "Password changed successfully"
    });

  } catch (error) {
    console.error("CHANGE PASSWORD ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to change password",
      error: error.message
    });
  }
});

module.exports = router;
