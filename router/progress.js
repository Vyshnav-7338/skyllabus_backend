const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Product = require("../models/Product");
const VideoProgress = require("../models/VideoProgress");
const Enrollment = require("../models/Enrollment");
const { sendApiError } = require("../utils/api-error");

const router = express.Router();

async function requireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return res.status(401).json({ success: false, message: "Authentication required" });
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user || user.status === "disabled") return res.status(401).json({ success: false, message: "User is unavailable" });
    req.user = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

function publishedVideoEntries(product) {
  const result = [];
  for (const module of product?.modules || []) {
    for (const chapter of module.chapters || []) {
      for (const video of chapter.videos || []) {
        if (video.isPublished) result.push({ module, chapter, video });
      }
    }
  }
  return result;
}

function findNestedVideo(product, moduleId, chapterId, videoId) {
  const module = product?.modules.id(moduleId);
  const chapter = module?.chapters.id(chapterId);
  const video = chapter?.videos.id(videoId);
  return module && chapter && video && video.isPublished ? { module, chapter, video } : null;
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
      moduleId: nested.module._id,
      chapterId: nested.chapter._id,
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

router.put("/product/:productId/module/:moduleId/chapter/:chapterId/video/:videoId", requireAuth, async (req, res) => {
  try {
    for (const value of Object.values(req.params)) {
      if (!mongoose.isValidObjectId(value)) return res.status(400).json({ success: false, message: "Invalid course content ID" });
    }
    const product = await Product.findById(req.params.productId);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const nested = findNestedVideo(product, req.params.moduleId, req.params.chapterId, req.params.videoId);
    if (!nested) return res.status(404).json({ success: false, message: "Video does not belong to the selected module and chapter" });
    return saveProgress(req, res, product, nested);
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to save video progress" });
  }
});

router.put("/video/:videoId", requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.videoId)) return res.status(400).json({ success: false, message: "Invalid video ID" });
    const product = await Product.findOne({ "modules.chapters.videos._id": req.params.videoId });
    if (!product) return res.status(404).json({ success: false, message: "Video not found" });
    const nested = publishedVideoEntries(product).find(({ video }) => video._id.toString() === req.params.videoId);
    if (!nested) return res.status(404).json({ success: false, message: "Video not found" });
    return saveProgress(req, res, product, nested);
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to save video progress" });
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
    const completed = new Set(videos.filter((item) => item.completed).map((item) => item.videoId.toString()));
    const modules = (product.modules || []).map((module) => {
      const moduleVideos = module.chapters.flatMap((chapter) => chapter.videos.filter((video) => video.isPublished));
      return {
        moduleId: module._id,
        totalVideos: moduleVideos.length,
        completedVideos: moduleVideos.filter((video) => completed.has(video._id.toString())).length,
        chapters: module.chapters.map((chapter) => {
          const chapterVideos = chapter.videos.filter((video) => video.isPublished);
          return {
            chapterId: chapter._id,
            totalVideos: chapterVideos.length,
            completedVideos: chapterVideos.filter((video) => completed.has(video._id.toString())).length,
          };
        }),
      };
    });
    return res.json({ success: true, data: { enrollment, videos, modules } });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to load video progress" });
  }
});

module.exports = router;
