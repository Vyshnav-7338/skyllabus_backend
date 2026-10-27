const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Product = require("../models/Product");
const VideoProgress = require("../models/VideoProgress");
const Enrollment = require("../models/Enrollment");
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
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

function publishedVideoEntries(product) {
  return product?.courseVideo?.isPublished
    ? [{ module: null, chapter: null, video: product.courseVideo }]
    : [];
}

async function updateCourseProgress(userId, product) {
  const entries = publishedVideoEntries(product);
  const progresses = await VideoProgress.find({ user: userId, product: product._id });
  const completedIds = new Set(progresses.filter((item) => item.completed).map((item) => item.videoId.toString()));
  const completeCount = entries.filter(({ video }) => completedIds.has(video._id.toString())).length;
  const progress = entries.length === 0 ? 0 : Math.round((completeCount / entries.length) * 100);
  const enrollment = await Enrollment.findOne({ user: userId, product: product._id });
  if (enrollment) {
    enrollment.progress = progress;
    enrollment.lastAccessedAt = new Date();
    enrollment.completed = entries.length > 0 && progress >= 100;
    enrollment.status = enrollment.completed ? "completed" : "active";
    enrollment.completedAt = enrollment.completed ? enrollment.completedAt || new Date() : null;
    await enrollment.save();
  }
  return { progress, completed: Boolean(enrollment?.completed), totalVideos: entries.length, completedVideos: completeCount };
}

async function saveProgress(req, res, product, nested) {
  const enrollment = await Enrollment.findOne({ user: req.user._id, product: product._id, status: { $ne: "cancelled" } });
  if (!enrollment) return res.status(403).json({ success: false, message: "Enroll in this course to save progress" });
  const currentTime = Math.max(0, Number(req.body.currentTime || 0));
  const duration = Math.max(0, Number(req.body.duration || 0));
  if (!Number.isFinite(currentTime) || !Number.isFinite(duration)) return res.status(400).json({ success: false, message: "Valid currentTime and duration are required" });
  const progressPercentage = duration > 0 ? Math.min(100, Number(((currentTime / duration) * 100).toFixed(2))) : 0;
  const completed = duration > 0 && (progressPercentage >= 95 || duration - currentTime <= 10);
  const progress = await VideoProgress.findOneAndUpdate(
    { user: req.user._id, product: product._id, videoId: nested.video._id },
    {
      user: req.user._id,
      product: product._id,
      moduleId: nested.module?._id || null,
      chapterId: nested.chapter?._id || null,
      videoId: nested.video._id,
      currentTime: Math.min(currentTime, duration || currentTime),
      duration,
      progressPercentage,
      started: true,
      completed,
      completedAt: completed ? new Date() : null,
      lastWatchedAt: new Date(),
    },
    { returnDocument: "after", upsert: true, runValidators: true },
  );
  const course = await updateCourseProgress(req.user._id, product);
  return res.json({ success: true, message: "Video progress saved", data: { progress, course } });
}

router.put("/product/:productId/course-video/:videoId", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.productId) || !mongoose.isValidObjectId(req.params.videoId)) {
      return res.status(400).json({ success: false, message: "Invalid course video ID" });
    }
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    if (!product.courseVideo?.isPublished || product.courseVideo._id.toString() !== req.params.videoId) {
      return res.status(404).json({ success: false, message: "Course video not found" });
    }
    return saveProgress(req, res, product, { module: null, chapter: null, video: product.courseVideo });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to save course video progress" });
  }
});

router.get("/product/:productId", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.productId)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    const [enrollment, product, videos] = await Promise.all([
      Enrollment.findOne({ user: req.user._id, product: req.params.productId }),
      Product.findById(req.params.productId),
      VideoProgress.find({ user: req.user._id, product: req.params.productId }).sort({ lastWatchedAt: -1 }),
    ]);
    if (!enrollment || !product) return res.status(404).json({ success: false, message: "Enrollment not found" });
    const modules = (product.modules || []).map((module) => ({ moduleId: module._id, assessmentId: module.assessment?._id || null }));
    const courseVideo = product.courseVideo ? {
      videoId: product.courseVideo._id,
      progress: videos.find((item) => item.videoId.toString() === product.courseVideo._id.toString()) || null,
    } : null;
    return res.json({ success: true, data: { enrollment, videos, courseVideo, modules } });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to load video progress" });
  }
});

module.exports = router;
