const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Product = require("../models/Product");
const ChapterPdf = require("../models/ChapterPdf");
const Enrollment = require("../models/Enrollment");
const User = require("../models/User");
const futils = require("../utils/fileutils");
const { pdfUpload } = require("../utils/content-upload");
const { sendApiError } = require("../utils/api-error");
const router = express.Router();

async function userFromRequest(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return null;
  try {
    const p = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    return User.findById(p.id);
  } catch (_) {
    return null;
  }
}
async function requireAdmin(req, res, next) {
  const u = await userFromRequest(req);
  if (!u)
    return res
      .status(401)
      .json({ success: false, message: "Authentication required" });
  if (u.role !== "admin")
    return res
      .status(403)
      .json({ success: false, message: "Admin access required" });
  req.user = u;
  next();
}
async function findProduct(req) {
  const productId = String(
    req.query.productId || req.body?.productId || "",
  ).trim();
  if (productId && mongoose.isValidObjectId(productId))
    return Product.findById(productId);
  const courseName = String(
    req.query.courseName || req.body?.courseName || "",
  ).trim();
  return courseName ? Product.findOne({ title: courseName }) : null;
}
function findModule(product, moduleId) {
  return (product.modules || []).find(
    (m) => m._id.toString() === String(moduleId),
  );
}
function findChapter(module, chapterId) {
  return (module?.chapters || []).find(
    (c) => c._id.toString() === String(chapterId),
  );
}
async function resolveOrCreateChapter(product, module, body) {
  let chapter = body.chapterId ? findChapter(module, body.chapterId) : null;
  if (chapter) return chapter;
  const title = String(body.chapterTitle || "").trim();
  if (!title)
    throw Object.assign(new Error("Chapter title is required"), {
      statusCode: 400,
    });
  chapter = module.chapters.create({
    title,
    description: String(body.description || "").trim(),
    order: Number(body.order || module.chapters.length + 1),
    isPublished: body.isPublished !== "false",
  });
  module.chapters.push(chapter);
  product.markModified("modules");
  await product.save();
  return module.chapters[module.chapters.length - 1];
}

router.get("/", async (req, res) => {
  try {
    const product = await findProduct(req);
    if (!product)
      return res
        .status(404)
        .json({ success: false, message: "Course not found" });
    const user = await userFromRequest(req);
    const allowed =
      user &&
      (user.role === "admin" ||
        (await Enrollment.exists({
          user: user._id,
          product: product._id,
          status: { $ne: "cancelled" },
        })));
    if (!allowed)
      return res
        .status(403)
        .json({
          success: false,
          message: "Enroll in this course to view chapter PDFs",
        });
    const docs = await ChapterPdf.find({
      product: product._id,
      isPublished: true,
    })
      .sort({ order: 1, createdAt: 1 })
      .lean();
    const modules = (product.modules || [])
      .filter((m) => m.isPublished !== false)
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        _id: m._id,
        title: m.title,
        description: m.description,
        order: m.order,
        isPublished: m.isPublished,
        chapters: docs
          .filter((d) => String(d.moduleId) === String(m._id))
          .map((d) => ({
            _id: d.chapterId,
            title: d.chapterTitle,
            description: d.description,
            order: d.order,
            isPublished: d.isPublished,
            pdfFile: d.pdfFile,
          })),
      }))
      .filter((m) => m.chapters.length);
    res.json({
      success: true,
      data: { productId: product._id, courseName: product.title, modules },
    });
  } catch (e) {
    return sendApiError(res, e, {
      fallbackMessage: "Unable to load chapter PDFs",
    });
  }
});

router.post("/", pdfUpload, async (req, res) => {
  let stored = null;
  try {
    const product = await findProduct(req);
    if (!product)
      return res
        .status(404)
        .json({ success: false, message: "Course not found" });
    const module = findModule(product, req.body.moduleId);
    if (!module)
      return res
        .status(400)
        .json({
          success: false,
          message: "Module does not belong to this course",
        });
    const chapter = await resolveOrCreateChapter(product, module, req.body);
    if (!req.file)
      return res
        .status(400)
        .json({ success: false, message: "PDF file is required" });
    stored = await futils.getFileObject(req.file);
    const previous = await ChapterPdf.findOne({
      product: product._id,
      moduleId: module._id,
      chapterId: chapter._id,
    });
    const oldFile = previous?.pdfFile;
    const doc = await ChapterPdf.findOneAndUpdate(
      { product: product._id, moduleId: module._id, chapterId: chapter._id },
      {
        product: product._id,
        moduleId: module._id,
        chapterId: chapter._id,
        moduleTitle: module.title,
        chapterTitle: chapter.title,
        description: String(req.body.description || chapter.description || ""),
        order: Number(req.body.order ?? chapter.order ?? 0),
        pdfFile: stored,
        isPublished: req.body.isPublished !== "false",
      },
      { upsert: true, new: true, runValidators: true },
    );
    if (oldFile) await futils.removeFileObject(oldFile);
    stored = null;
    res
      .status(201)
      .json({ success: true, message: "Chapter PDF saved", data: doc });
  } catch (e) {
    if (stored) await futils.removeFileObject(stored);
    return sendApiError(res, e, {
      fallbackMessage: "Unable to save chapter PDF",
    });
  } finally {
    if (req.file?.path)
      await require("fs")
        .promises.rm(req.file.path, { force: true })
        .catch(() => {});
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const doc = await ChapterPdf.findByIdAndDelete(req.params.id);
    if (!doc)
      return res
        .status(404)
        .json({ success: false, message: "Chapter PDF not found" });
    await futils.removeFileObject(doc.pdfFile);
    res.json({ success: true, message: "Chapter PDF deleted" });
  } catch (e) {
    return sendApiError(res, e, {
      fallbackMessage: "Unable to delete chapter PDF",
    });
  }
});
module.exports = router;
