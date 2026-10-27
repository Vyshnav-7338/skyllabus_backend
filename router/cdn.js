const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { resolveMediaPath } = require("../utils/fileutils");
const Enrollment = require("../models/Enrollment");
const Product = require("../models/Product");
const User = require("../models/User");

const router = express.Router();
JWT_SECRET='local-development-secret-change-before-production'

const mimeByExtension = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function streamFile(req, res, relativeName) {
  const filePath = resolveMediaPath(relativeName);
  if (!filePath) return res.status(400).json({ success: false, message: "Invalid media path" });
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_error) {
    return res.status(404).json({ success: false, message: "Media not found" });
  }
  if (!stat.isFile()) return res.status(404).json({ success: false, message: "Media not found" });
  const range = req.headers.range;
  res.setHeader("Content-Type", mimeByExtension[path.extname(filePath).toLowerCase()] || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(filePath).replace(/"/g, "")}"`);
  if (!range) {
    res.setHeader("Content-Length", stat.size);
    return fs.createReadStream(filePath).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
  }
  const boundedEnd = Math.min(end, stat.size - 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${boundedEnd}/${stat.size}`);
  res.setHeader("Content-Length", boundedEnd - start + 1);
  return fs.createReadStream(filePath, { start, end: boundedEnd }).pipe(res);
}

async function authorizeCourseVideo(req, res, next) {
  try {
    const fileName = String(req.query.file || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const product = await Product.findOne({ "courseVideo.file.name": fileName }).select("_id");
    if (!product) return next();

    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = await User.findById(payload.id).select("role status");
    if (!user || user.status === "disabled") {
      return res.status(401).json({ success: false, message: "User is unavailable" });
    }
    if (user.role === "admin") return next();
    const enrolled = await Enrollment.exists({
      user: user._id,
      product: product._id,
      status: { $ne: "cancelled" },
    });
    if (!enrolled) {
      return res.status(403).json({ success: false, message: "Enroll in this course to play its video" });
    }
    return next();
  } catch (error) {
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
    return next(error);
  }
}

router.get("/cdn", authorizeCourseVideo, (req, res) => streamFile(req, res, req.query.file));
router.get("/thumb/:file", (req, res) => streamFile(req, res, `thumb/${req.params.file}`));
router.get("/hls/:videoId/:file", (req, res) => streamFile(req, res, `hls/${req.params.videoId}/${req.params.file}`));

module.exports = router;
