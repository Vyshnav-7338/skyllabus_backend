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

function validatedYoutubeUrl(value) {
  const youtubeUrl = String(value || "").trim();
  if (!youtubeUrl) return "";
  let parsed;
  try {
    parsed = new URL(youtubeUrl);
  } catch (_error) {
    throw validationError("Course video must be a valid YouTube URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isShortUrl = host === "youtu.be" || host === "www.youtu.be";
  const isYoutubeUrl = host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com";
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  let videoId = "";
  if (isShortUrl) videoId = pathSegments[0] || "";
  if (isYoutubeUrl) {
    videoId = parsed.searchParams.get("v") || "";
    if (!videoId && pathSegments.length >= 2 && ["embed", "shorts", "live"].includes(pathSegments[0])) {
      videoId = pathSegments[1];
    }
  }
  if (parsed.protocol !== "https:" || (!isShortUrl && !isYoutubeUrl) || !/^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
    throw validationError("Course video must be a valid YouTube URL");
  }
  return youtubeUrl;
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

async function requireUser(req, res, next) {
  const user = await optionalUser(req);
  if (!user) return res.status(401).json({ success: false, message: "Authentication required" });
  req.user = user;
  return next();
}


function parseJsonField(value, label) {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  try { return JSON.parse(String(value)); }
  catch (_error) { throw validationError(`${label} must be valid JSON`); }
}

function existingById(items, id, label) {
  if (!id) return null;
  const found = (items || []).find((item) => item._id?.toString() === String(id));
  if (!found) throw validationError(`${label} id does not belong to this product`);
  return found;
}

function normalizeAnswerIndex(question, moduleIndex, questionIndex) {
  const options = (question.options || []).map((item) => String(item || "").trim());
  if (options.length !== 4 || options.some((item) => !item)) {
    throw validationError(`Module ${moduleIndex + 1}, question ${questionIndex + 1}: exactly 4 non-empty options are required`);
  }
  let answer = question.correctAnswerIndex ?? question.answerIndex ?? question.answer ?? question.correctAnswer;
  if (typeof answer === "string" && !/^\d+$/.test(answer.trim())) {
    const raw = answer.trim();
    const letter = raw.toLowerCase();
    if (/^[a-d]$/.test(letter)) answer = letter.charCodeAt(0) - 97;
    else answer = options.findIndex((option) => option.toLowerCase() === raw.toLowerCase());
  }
  answer = Number(answer);
  // Accept UI values 1-4 when answer/correctAnswer is supplied, but keep explicit correctAnswerIndex as 0-3.
  if (question.correctAnswerIndex === undefined && question.answerIndex === undefined && Number.isInteger(answer) && answer >= 1 && answer <= 4) answer -= 1;
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
    throw validationError(`Module ${moduleIndex + 1}, question ${questionIndex + 1}: answer must select one of the 4 options`);
  }
  return { options, correctAnswerIndex: answer };
}

async function buildModules(product, rawModules, files, createdMedia) {
  const modules = parseJsonField(rawModules, "Modules");
  if (!Array.isArray(modules)) throw validationError("Modules must be an array");
  const oldModules = product.modules || [];
  const result = [];

  for (let mi = 0; mi < modules.length; mi += 1) {
    const input = modules[mi] || {};
    const oldModule = existingById(oldModules, input.id || input._id, `Module ${mi + 1}`);
    const title = String(input.title || oldModule?.title || "").trim();
    if (!title) throw validationError(`Module ${mi + 1}: title is required`);
    const rawChapters = input.chapters ?? [];
    if (!Array.isArray(rawChapters)) throw validationError(`Module ${mi + 1}: chapters must be an array`);
    const chapters = [];

    for (let ci = 0; ci < rawChapters.length; ci += 1) {
      const chapterInput = rawChapters[ci] || {};
      const oldChapter = existingById(oldModule?.chapters || [], chapterInput.id || chapterInput._id, `Module ${mi + 1}, chapter ${ci + 1}`);
      const chapterTitle = String(chapterInput.title || oldChapter?.title || "").trim();
      if (!chapterTitle) throw validationError(`Module ${mi + 1}, chapter ${ci + 1}: title is required`);
      chapters.push({
        ...(oldChapter?._id ? { _id: oldChapter._id } : {}),
        title: chapterTitle,
        description: String(chapterInput.description ?? oldChapter?.description ?? "").trim(),
        order: validOrder(chapterInput.order, ci + 1, `Module ${mi + 1}, chapter ${ci + 1}`),
        isPublished: toBoolean(chapterInput.isPublished, oldChapter?.isPublished !== false),
      });
    }

    let assessment = null;
    // Assessment JSON files are parsed only in the admin browser.
    // The backend receives normal assessment data inside modules[].assessment.
    let suppliedAssessment = input.assessment;
    if (typeof suppliedAssessment === "string" && suppliedAssessment !== "null") {
      suppliedAssessment = parseJsonField(suppliedAssessment, `Module ${mi + 1} assessment`);
    }
    if (suppliedAssessment !== null && suppliedAssessment !== "null" && suppliedAssessment !== undefined) {
      const a = suppliedAssessment || {};
      const oldAssessment = oldModule?.assessment;
      const rawQuestions = a.questions ?? [];
      if (!Array.isArray(rawQuestions)) throw validationError(`Module ${mi + 1}: assessment questions must be an array`);
      const questions = rawQuestions.map((q, qi) => {
        const oldQuestion = existingById(oldAssessment?.questions || [], q.id || q._id, `Module ${mi + 1}, question ${qi + 1}`);
        const questionText = String(q.question || oldQuestion?.question || "").trim();
        if (!questionText) throw validationError(`Module ${mi + 1}, question ${qi + 1}: question is required`);
        const normalized = normalizeAnswerIndex(q, mi, qi);
        return { ...(oldQuestion?._id ? { _id: oldQuestion._id } : {}), question: questionText, ...normalized };
      });
      assessment = {
        ...(oldAssessment?._id ? { _id: oldAssessment._id } : {}),
        title: String(a.title || oldAssessment?.title || `${title} Assessment`).trim(),
        passingPercentage: Number(a.passingPercentage ?? oldAssessment?.passingPercentage ?? 50),
        questions,
        isPublished: toBoolean(a.isPublished, oldAssessment?.isPublished !== false),
      };
      if (!Number.isFinite(assessment.passingPercentage) || assessment.passingPercentage < 0 || assessment.passingPercentage > 100) {
        throw validationError(`Module ${mi + 1}: passing percentage must be between 0 and 100`);
      }
    } else if (suppliedAssessment === undefined && oldModule?.assessment) {
      assessment = oldModule.assessment.toObject ? oldModule.assessment.toObject() : oldModule.assessment;
    }

    result.push({
      ...(oldModule?._id ? { _id: oldModule._id } : {}), title,
      description: String(input.description ?? oldModule?.description ?? "").trim(),
      order: validOrder(input.order, mi + 1, `Module ${mi + 1}`), chapters, assessment,
      isPublished: toBoolean(input.isPublished, oldModule?.isPublished !== false),
    });
  }
  return result;
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

  if (body.courseVideo !== undefined) {
    let metadata = body.courseVideo;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch (_error) {
        throw validationError("Course video must be valid JSON");
      }
    }
    if (metadata === null || metadata === "null") {
      product.courseVideo = null;
    } else {
      metadata = metadata && typeof metadata === "object" ? metadata : {};
      const suppliedYoutubeUrl = metadata.youtubeUrl ?? metadata.url;
      const youtubeUrl = suppliedYoutubeUrl === undefined
        ? String(product.courseVideo?.youtubeUrl || "")
        : validatedYoutubeUrl(suppliedYoutubeUrl);
      if (!youtubeUrl) throw validationError("Course video requires a YouTube URL");
      product.courseVideo = {
        ...(product.courseVideo?._id ? { _id: product.courseVideo._id } : {}),
        title: String(metadata.title || product.courseVideo?.title || `${title} Video`).trim(),
        description: String(metadata.description || product.courseVideo?.description || "").trim(),
        youtubeUrl,
        duration: String(metadata.duration || product.courseVideo?.duration || "").trim(),
        isPublished: toBoolean(metadata.isPublished, product.courseVideo?.isPublished !== false),
      };
    }
  }

  // Modules/assessments are sent as JSON text in the multipart form. Parse and
  // assign them explicitly so Mongoose persists the nested subdocuments.
  if (Object.prototype.hasOwnProperty.call(body, "modules")) {
    const builtModules = await buildModules(product, body.modules, files, createdMedia);
    product.set("modules", builtModules);
    product.markModified("modules");
  } else if (creating) {
    product.set("modules", []);
  }
}


function allVideoIds(product) {
  return product.courseVideo?._id ? [product.courseVideo._id.toString()] : [];
}

function publishedVideos(product) {
  return product.courseVideo?.isPublished ? [product.courseVideo] : [];
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
  if (data.courseVideo) data.courseVideo.youtubeUrl = admin || canAccess ? data.courseVideo.youtubeUrl : "";
  data.modules = (data.modules || []).sort((a, b) => a.order - b.order).map((module) => {
    module.chapters = (module.chapters || []).sort((a, b) => a.order - b.order).map((chapter) => {
      return chapter;
    });
    if (!admin && module.assessment?.questions) {
      module.assessment.questions = module.assessment.questions.map(({ correctAnswerIndex, ...question }) => question);
    }
    return module;
  });
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
      const [products, total] = await Promise.all([
        Product.find(filter).populate("category").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        Product.countDocuments(filter),
      ]);
      return res.json({ success: true, data: products.map((product) => sortedProduct(product, true, true)), meta: { page, limit, total, pages: Math.ceil(total / limit) } });
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

router.get("/:id/manage", async (req, res) => {
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

router.post("/", productUpload, async (req, res) => {
  const createdMedia = [];
  let committed = false;
  try {
    const product = new Product();
    await applyProductFields(product, req.body, req.files, true, createdMedia);
    await product.save();
    committed = true;
    const persisted = await Product.findById(product._id).populate("category");
    if (Object.prototype.hasOwnProperty.call(req.body, "modules")) {
      const expectedModules = parseJsonField(req.body.modules, "Modules");
      if ((persisted.modules || []).length !== expectedModules.length) {
        throw new Error(`Modules persistence failed: expected ${expectedModules.length}, saved ${(persisted.modules || []).length}`);
      }
    }
    return res.status(201).json({ success: true, message: "Product created successfully", data: sortedProduct(persisted, true, true) });
  } catch (error) {
    if (!committed) await Promise.all(createdMedia.map((value) => futils.removeFileObject(value)));
    return sendApiError(res, error, { duplicateMessage: "Product slug already exists", fallbackMessage: "Unable to create product" });
  } finally {
    await futils.removeIncoming(req.files);
  }
});

router.put("/:id", productUpload, async (req, res) => {
  const createdMedia = [];
  let committed = false;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw validationError("Invalid product ID");
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const oldMedia = collectProductMedia(product);
    const oldVideoIds = new Set(allVideoIds(product));
    await applyProductFields(product, req.body, req.files, false, createdMedia);
    await product.save();
    committed = true;
    // Reload after save to verify the nested module/assessment data really reached MongoDB.
    const verifyPersisted = await Product.findById(product._id);
    if (Object.prototype.hasOwnProperty.call(req.body, "modules")) {
      const expectedModules = parseJsonField(req.body.modules, "Modules");
      if ((verifyPersisted.modules || []).length !== expectedModules.length) {
        throw new Error(`Modules persistence failed: expected ${expectedModules.length}, saved ${(verifyPersisted.modules || []).length}`);
      }
    }
    const currentVideoIds = new Set(allVideoIds(product));
    const removedVideoIds = [...oldVideoIds].filter((id) => !currentVideoIds.has(id));
    if (removedVideoIds.length) await VideoProgress.deleteMany({ product: product._id, videoId: { $in: removedVideoIds } });
    await refreshEnrollmentProgress(product);
    await cleanupObsolete(oldMedia, collectProductMedia(product));
    const persisted = await Product.findById(product._id).populate("category");
    return res.json({ success: true, message: "Product updated successfully", data: sortedProduct(persisted, true, true) });
  } catch (error) {
    if (!committed) await Promise.all(createdMedia.map((value) => futils.removeFileObject(value)));
    return sendApiError(res, error, { duplicateMessage: "Product slug already exists", fallbackMessage: "Unable to update product" });
  } finally {
    await futils.removeIncoming(req.files);
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    if (await Enrollment.exists({ product: req.params.id })) return res.status(409).json({ success: false, message: "This product has enrollment history and cannot be deleted" });
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    const media = collectProductMedia(product);
    await VideoProgress.deleteMany({ product: product._id });
    await product.deleteOne();
    await Promise.all(media.map(removeIfUnreferenced));
    return res.json({ success: true, message: "Product deleted successfully", data: product });
  } catch (error) {
    return sendApiError(res, error, { fallbackMessage: "Unable to delete product" });
  }
});

module.exports = router;
