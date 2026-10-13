const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Product = require("../models/Product");
const Category = require("../models/Category");
const VideoProgress = require("../models/VideoProgress");
const User = require("../models/User");
const Enrollment = require("../models/Enrollment");
const futils = require("../utils/fileutils");
const { productUpload } = require("../utils/media-upload");
const { collectProductMedia, mediaKey, removeIfUnreferenced } = require("../utils/media-references");
const { sendApiError } = require("../utils/api-error");

const router = express.Router();

function slugify(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function toBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === true || value === "true" || value === "1" || value === 1;
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  return String(value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validOrder(value, fallback, label) {
  const order = Number(value ?? fallback);
  if (!Number.isFinite(order) || order < 0) throw validationError(`${label} order must be zero or greater`);
  return order;
}

function uploadedFile(files, fieldname) {
  return (files || []).find((file) => file.fieldname === fieldname);
}

function plainFile(value) {
  if (!value) return null;
  return typeof value.toObject === "function" ? value.toObject() : { ...value };
}

async function requireAdmin(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return res.status(401).json({ success: false, message: "Authentication required" });
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ success: false, message: "User no longer exists" });
    if (user.role !== "admin") return res.status(403).json({ success: false, message: "Admin access required" });
    req.user = user;
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

async function optionalUser(req) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return null;
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    return User.findOne({ _id: payload.id, status: { $ne: "disabled" } });
  } catch (_error) {
    return null;
  }
}

function parseModules(body) {
  if (body.modules === undefined) return null;
  let modules;
  try {
    modules = Array.isArray(body.modules) ? body.modules : JSON.parse(body.modules);
  } catch (_error) {
    throw validationError("Course modules must be valid JSON");
  }
  if (!Array.isArray(modules)) throw validationError("Course modules must be an array");
  if (modules.length > 100) throw validationError("A product can contain at most 100 modules");
  return modules;
}

function existingById(items) {
  return new Map(Array.from(items || []).map((item) => [item._id.toString(), item]));
}

function validateEmbeddedId(id, map, label) {
  if (!id) return null;
  if (!mongoose.isValidObjectId(id) || !map.has(id)) throw validationError(`${label} does not belong to this product`);
  return map.get(id);
}

async function buildNestedContent(product, rawModules, files, createdMedia) {
  if (rawModules === null) return;
  const oldModules = existingById(product.modules);
  const seenModuleIds = new Set();
  const modules = [];

  for (let moduleIndex = 0; moduleIndex < rawModules.length; moduleIndex += 1) {
    const rawModule = rawModules[moduleIndex] || {};
    const moduleId = String(rawModule.id || rawModule._id || "").trim();
    if (moduleId && seenModuleIds.has(moduleId)) throw validationError("A module cannot be included more than once");
    if (moduleId) seenModuleIds.add(moduleId);
    const existingModule = validateEmbeddedId(moduleId, oldModules, "Module");
    const title = String(rawModule.title || "").trim();
    if (!title) throw validationError(`Module ${moduleIndex + 1} title is required`);
    const rawChapters = rawModule.chapters ?? [];
    if (!Array.isArray(rawChapters)) throw validationError(`Module ${moduleIndex + 1} chapters must be an array`);
    if (rawChapters.length > 100) throw validationError(`Module ${moduleIndex + 1} can contain at most 100 chapters`);
    const oldChapters = existingById(existingModule?.chapters);
    const seenChapterIds = new Set();
    const chapters = [];

    for (let chapterIndex = 0; chapterIndex < rawChapters.length; chapterIndex += 1) {
      const rawChapter = rawChapters[chapterIndex] || {};
      const chapterId = String(rawChapter.id || rawChapter._id || "").trim();
      if (chapterId && seenChapterIds.has(chapterId)) throw validationError("A chapter cannot be included more than once");
      if (chapterId) seenChapterIds.add(chapterId);
      const existingChapter = validateEmbeddedId(chapterId, oldChapters, "Chapter");
      const chapterTitle = String(rawChapter.title || "").trim();
      if (!chapterTitle) throw validationError(`Chapter ${chapterIndex + 1} title is required`);
      const rawVideos = rawChapter.videos ?? [];
      const rawNotes = rawChapter.notes ?? [];
      if (!Array.isArray(rawVideos) || !Array.isArray(rawNotes)) throw validationError("Chapter videos and notes must be arrays");
      if (rawVideos.length > 100 || rawNotes.length > 100) throw validationError("A chapter can contain at most 100 videos and 100 notes");

      const oldVideos = existingById(existingChapter?.videos);
      const oldNotes = existingById(existingChapter?.notes);
      const seenVideoIds = new Set();
      const seenNoteIds = new Set();
      const videos = [];
      const notes = [];

      for (let videoIndex = 0; videoIndex < rawVideos.length; videoIndex += 1) {
        const rawVideo = rawVideos[videoIndex] || {};
        const videoId = String(rawVideo.id || rawVideo._id || "").trim();
        if (videoId && seenVideoIds.has(videoId)) throw validationError("A video cannot be included more than once");
        if (videoId) seenVideoIds.add(videoId);
        const existingVideo = validateEmbeddedId(videoId, oldVideos, "Video");
        const videoTitle = String(rawVideo.title || "").trim();
        if (!videoTitle) throw validationError(`Video ${videoIndex + 1} title is required`);
        const upload = uploadedFile(files, `videoFile_${moduleIndex}_${chapterIndex}_${videoIndex}`);
        const file = upload ? await futils.getFileObject(upload) : plainFile(existingVideo?.file);
        if (upload) createdMedia.push(file);
        if (!file?.name) throw validationError(`Video ${videoIndex + 1} requires a video file`);
        videos.push({
          ...(existingVideo ? { _id: existingVideo._id } : {}),
          title: videoTitle,
          description: String(rawVideo.description || "").trim(),
          file,
          duration: String(rawVideo.duration || "").trim(),
          order: validOrder(rawVideo.order, videoIndex + 1, `Video ${videoIndex + 1}`),
          isPreview: toBoolean(rawVideo.isPreview),
          isPublished: toBoolean(rawVideo.isPublished, true),
        });
      }

      for (let noteIndex = 0; noteIndex < rawNotes.length; noteIndex += 1) {
        const rawNote = rawNotes[noteIndex] || {};
        const noteId = String(rawNote.id || rawNote._id || "").trim();
        if (noteId && seenNoteIds.has(noteId)) throw validationError("A note cannot be included more than once");
        if (noteId) seenNoteIds.add(noteId);
        const existingNote = validateEmbeddedId(noteId, oldNotes, "Note");
        const noteTitle = String(rawNote.title || "").trim();
        if (!noteTitle) throw validationError(`Note ${noteIndex + 1} title is required`);
        const upload = uploadedFile(files, `noteFile_${moduleIndex}_${chapterIndex}_${noteIndex}`);
        const file = upload ? await futils.getFileObject(upload) : plainFile(existingNote?.file);
        if (upload) createdMedia.push(file);
        if (!file?.name) throw validationError(`Note ${noteIndex + 1} requires a note file`);
        notes.push({
          ...(existingNote ? { _id: existingNote._id } : {}),
          title: noteTitle,
          description: String(rawNote.description || "").trim(),
          file,
          order: validOrder(rawNote.order, noteIndex + 1, `Note ${noteIndex + 1}`),
          isPublished: toBoolean(rawNote.isPublished, true),
        });
      }

      videos.sort((left, right) => left.order - right.order);
      notes.sort((left, right) => left.order - right.order);
      chapters.push({
        ...(existingChapter ? { _id: existingChapter._id } : {}),
        title: chapterTitle,
        description: String(rawChapter.description || "").trim(),
        order: validOrder(rawChapter.order, chapterIndex + 1, `Chapter ${chapterIndex + 1}`),
        videos,
        notes,
      });
    }

    chapters.sort((left, right) => left.order - right.order);
    modules.push({
      ...(existingModule ? { _id: existingModule._id } : {}),
      title,
      description: String(rawModule.description || "").trim(),
      order: validOrder(rawModule.order, moduleIndex + 1, `Module ${moduleIndex + 1}`),
      chapters,
    });
  }

  modules.sort((left, right) => left.order - right.order);
  product.modules = modules;
}

async function applyProductFields(product, body, files, creating, createdMedia) {
  const title = String(body.title ?? product.title ?? "").trim();
  const categoryId = String(body.categoryId || body.category || product.category || "").trim();
  if (creating && (!title || !body.shortDescription || !body.description || !categoryId || body.price === undefined || !body.instructorName || !body.currency || !body.level)) {
    throw validationError("Title, descriptions, category, instructor, price, currency, and level are required");
  }
  const textFields = ["title", "shortDescription", "description", "instructorName", "currency", "level", "duration", "incomeOpportunity"];
  for (const field of textFields) if (body[field] !== undefined) product[field] = String(body[field]).trim();
  if (body.slug !== undefined || body.title !== undefined || creating) product.slug = slugify(body.slug || title);
  for (const field of ["originalPrice", "price", "offerPrice", "enrollmentCount"]) if (body[field] !== undefined) product[field] = Number(body[field]);
  for (const field of ["certificateAvailable", "isFeatured", "isPublished", "isActive"]) if (body[field] !== undefined) product[field] = toBoolean(body[field]);
  if (body.tags !== undefined) product.tags = parseTags(body.tags);
  if (!mongoose.isValidObjectId(categoryId) || !(await Category.exists({ _id: categoryId }))) throw validationError("Valid category is required");
  product.category = categoryId;

  for (const field of ["thumbnail", "banner"]) {
    const upload = uploadedFile(files, field);
    if (upload) {
      const file = await futils.getFileObject(upload);
      createdMedia.push(file);
      product[field] = file;
    }
  }
}

function allVideoIds(product) {
  const ids = [];
  for (const module of product.modules || []) {
    for (const chapter of module.chapters || []) {
      for (const video of chapter.videos || []) ids.push(video._id.toString());
    }
  }
  return ids;
}

function publishedVideos(product) {
  const result = [];
  for (const module of product.modules || []) {
    for (const chapter of module.chapters || []) {
      for (const video of chapter.videos || []) if (video.isPublished) result.push(video);
    }
  }
  return result;
}

async function refreshEnrollmentProgress(product) {
  const requiredIds = publishedVideos(product).map((video) => video._id.toString());
  const enrollments = await Enrollment.find({ product: product._id, status: { $ne: "cancelled" } });
  await Promise.all(enrollments.map(async (enrollment) => {
    const completed = requiredIds.length ? await VideoProgress.countDocuments({
      user: enrollment.user,
      product: product._id,
      videoId: { $in: requiredIds },
      completed: true,
    }) : 0;
    enrollment.progress = requiredIds.length ? Math.round((completed / requiredIds.length) * 100) : 0;
    enrollment.completed = requiredIds.length > 0 && enrollment.progress >= 100;
    enrollment.status = enrollment.completed ? "completed" : "active";
    enrollment.completedAt = enrollment.completed ? enrollment.completedAt || new Date() : null;
    await enrollment.save();
  }));
}

function sortedProduct(product, canAccess = false, admin = false) {
  const data = typeof product.toObject === "function" ? product.toObject() : structuredClone(product);
  data.modules = (data.modules || []).sort((a, b) => a.order - b.order).map((module) => ({
    ...module,
    chapters: (module.chapters || []).sort((a, b) => a.order - b.order).map((chapter) => ({
      ...chapter,
      videos: (chapter.videos || []).filter((video) => admin || video.isPublished).sort((a, b) => a.order - b.order).map((video) => ({
        ...video,
        file: admin || canAccess || video.isPreview ? video.file : null,
      })),
      notes: (chapter.notes || []).filter((note) => admin || note.isPublished).sort((a, b) => a.order - b.order).map((note) => ({
        ...note,
        file: admin || canAccess ? note.file : null,
      })),
    })),
  }));
  return data;
}

async function cleanupObsolete(oldMedia, currentMedia) {
  const current = new Set(currentMedia.map(mediaKey));
  for (const value of oldMedia) {
    if (!current.has(mediaKey(value))) await removeIfUnreferenced(value);
  }
}

router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const filter = {};
    const includeUnpublished = req.query.includeUnpublished === "true";
    if (!includeUnpublished) {
      filter.isPublished = true;
      filter.isActive = { $ne: false };
    }
    if (req.query.category) {
      if (!mongoose.isValidObjectId(req.query.category)) return res.status(400).json({ success: false, message: "Invalid category ID" });
      filter.category = req.query.category;
    }
    if (req.query.featured === "true") filter.isFeatured = true;
    if (req.query.search) {
      const search = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [{ title: { $regex: search, $options: "i" } }, { shortDescription: { $regex: search, $options: "i" } }, { description: { $regex: search, $options: "i" } }, { tags: { $regex: search, $options: "i" } }];
    }
    if (includeUnpublished) {
      return requireAdmin(req, res, async () => {
        const [products, total] = await Promise.all([
          Product.find(filter).populate("category").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
          Product.countDocuments(filter),
        ]);
        return res.json({ success: true, data: products.map((product) => sortedProduct(product, true, true)), meta: { page, limit, total, pages: Math.ceil(total / limit) } });
      });
    }
    const [products, total] = await Promise.all([
      Product.find(filter).populate("category").sort({ isFeatured: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Product.countDocuments(filter),
    ]);
    return res.json({ success: true, data: products.map((product) => sortedProduct(product)), meta: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to load products" });
  }
});

router.get("/category/:categoryId", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.categoryId)) return res.status(400).json({ success: false, message: "Invalid category ID" });
    const products = await Product.find({ category: req.params.categoryId, isPublished: true, isActive: { $ne: false } }).populate("category").sort({ isFeatured: -1, createdAt: -1 });
    return res.json({ success: true, data: products.map((product) => sortedProduct(product)) });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to load category products" });
  }
});

router.get("/:id/manage", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    const product = await Product.findById(req.params.id).populate("category");
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    return res.json({ success: true, data: sortedProduct(product, true, true) });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to load product editor" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    const product = await Product.findOne({ _id: req.params.id, isPublished: true, isActive: { $ne: false } }).populate("category");
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const user = await optionalUser(req);
    const canAccess = user ? Boolean(await Enrollment.exists({ user: user._id, product: product._id, status: { $ne: "cancelled" } })) : false;
    return res.json({ success: true, data: sortedProduct(product, canAccess) });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to load product" });
  }
});

router.post("/", requireAdmin, productUpload, async (req, res) => {
  const createdMedia = [];
  let committed = false;
  try {
    const product = new Product();
    await applyProductFields(product, req.body, req.files, true, createdMedia);
    await buildNestedContent(product, parseModules(req.body), req.files, createdMedia);
    await product.save();
    committed = true;
    const persisted = await Product.findById(product._id).populate("category");
    return res.status(201).json({ success: true, message: "Product and course content created successfully", data: sortedProduct(persisted, true, true) });
  } catch (error) {
    if (!committed) await Promise.all(createdMedia.map((value) => futils.removeFileObject(value)));
    return sendApiError(res, error, { duplicateMessage: "Product slug already exists", fallbackMessage: "Unable to create product" });
  } finally {
    await futils.removeIncoming(req.files);
  }
});

router.put("/:id", requireAdmin, productUpload, async (req, res) => {
  const createdMedia = [];
  let committed = false;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw validationError("Invalid product ID");
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const oldMedia = collectProductMedia(product);
    const oldVideoIds = new Set(allVideoIds(product));
    await applyProductFields(product, req.body, req.files, false, createdMedia);
    await buildNestedContent(product, parseModules(req.body), req.files, createdMedia);
    await product.save();
    committed = true;
    const currentVideoIds = new Set(allVideoIds(product));
    const removedVideoIds = [...oldVideoIds].filter((id) => !currentVideoIds.has(id));
    if (removedVideoIds.length) await VideoProgress.deleteMany({ product: product._id, videoId: { $in: removedVideoIds } });
    await refreshEnrollmentProgress(product);
    await cleanupObsolete(oldMedia, collectProductMedia(product));
    const persisted = await Product.findById(product._id).populate("category");
    return res.json({ success: true, message: "Product and course content updated successfully", data: sortedProduct(persisted, true, true) });
  } catch (error) {
    if (!committed) await Promise.all(createdMedia.map((value) => futils.removeFileObject(value)));
    return sendApiError(res, error, { duplicateMessage: "Product slug already exists", fallbackMessage: "Unable to update product" });
  } finally {
    await futils.removeIncoming(req.files);
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    if (await Enrollment.exists({ product: req.params.id })) return res.status(409).json({ success: false, message: "This product has enrollment history and cannot be deleted" });
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const media = collectProductMedia(product);
    await VideoProgress.deleteMany({ product: product._id });
    await product.deleteOne();
    await Promise.all(media.map(removeIfUnreferenced));
    return res.json({ success: true, message: "Product and associated course content deleted successfully", data: product });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to delete product" });
  }
});

module.exports = router;
