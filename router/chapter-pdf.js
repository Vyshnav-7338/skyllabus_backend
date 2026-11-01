const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Product = require("../models/Product");
const ChapterPdf = require("../models/ChapterPdf");
const User = require("../models/User");

const futils = require("../utils/fileutils");
const { sendApiError } = require("../utils/api-error");

const router = express.Router();


// =====================================================
// USER FROM TOKEN
// =====================================================

async function userFromRequest(req) {

  const authHeader =
    String(req.headers.authorization || "");

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  try {

    const payload = jwt.verify(
      authHeader.slice(7),
      process.env.JWT_SECRET
    );

    return await User.findById(payload.id);

  } catch (error) {

    return null;
  }
}


// =====================================================
// ADMIN AUTH
// =====================================================

async function requireAdmin(req, res, next) {

  try {

    const user =
      await userFromRequest(req);

    if (!user) {

      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });

    }

    if (user.role !== "admin") {

      return res.status(403).json({
        success: false,
        message: "Admin access required"
      });

    }

    req.user = user;

    next();

  } catch (error) {

    return sendApiError(
      res,
      error,
      {
        fallbackMessage:
          "Authentication failed"
      }
    );

  }
}


// =====================================================
// FIND PRODUCT
// =====================================================

async function findProduct(req) {

  const productId = String(
    req.body?.productId ||
    req.query?.productId ||
    ""
  ).trim();


  if (
    productId &&
    mongoose.isValidObjectId(productId)
  ) {

    return await Product.findById(
      productId
    );

  }


  const courseName = String(
    req.body?.courseName ||
    req.query?.courseName ||
    ""
  ).trim();


  if (!courseName) {
    return null;
  }


  return await Product.findOne({
    title: courseName
  });

}


// =====================================================
// FIND MODULE
// =====================================================

function findModule(product, moduleId) {

  if (!moduleId) {
    return null;
  }

  return (product.modules || []).find(
    module =>
      String(module._id) ===
      String(moduleId)
  );

}


// =====================================================
// POST CHAPTER PDF
// =====================================================
//
// POST /api/chapter-pdfs
//
// multipart/form-data
//
// productId
// OR courseName
//
// moduleId
// chapterTitle
// chapterDescription
// pdf
//
// =====================================================


router.post("/", async (req, res) => {
  try {
    console.log("BODY:", req.body);
    console.log("FILES:", req.files);

    // ==============================
    // CHECK PDF
    // ==============================
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        success: false,
        message: "PDF file is required",
      });
    }

    const file = req.files.pdf;

    // ==============================
    // VALIDATE PDF
    // ==============================
    if (
      file.mimetype !== "application/pdf" &&
      !String(file.name).toLowerCase().endsWith(".pdf")
    ) {
      return res.status(400).json({
        success: false,
        message: "Only PDF files are allowed",
      });
    }

    // ==============================
    // FIND COURSE
    // ==============================
    const product = await findProduct(req);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    // ==============================
    // FIND MODULE
    // ==============================
    const module = findModule(product, req.body.moduleId);

    if (!module) {
      return res.status(404).json({
        success: false,
        message: "Module not found",
      });
    }

    // ==============================
    // REQUIRED FIELDS
    // ==============================
    const chapterTitle = String(
      req.body.chapterTitle || ""
    ).trim();

    if (!chapterTitle) {
      return res.status(400).json({
        success: false,
        message: "Chapter title is required",
      });
    }

    // ==============================
    // SAVE PDF FILE
    // ==============================
    const pdfObject = await futils.getFileObject(file);

    console.log("PDF OBJECT:", pdfObject);

    // ==============================
    // CREATE DATABASE DOCUMENT
    // NO DUPLICATE CHECK
    // ==============================
    const chapterPdf = await ChapterPdf.create({
      product: product._id,

      moduleId: module._id,

      moduleTitle: module.title,

      chapterTitle: chapterTitle,

      description: String(
        req.body.description ||
        req.body.chapterDescription ||
        ""
      ).trim(),

      order: Number(req.body.order || 1),

      isPublished:
        req.body.isPublished === undefined
          ? true
          : String(req.body.isPublished) === "true",

      pdf: pdfObject,
    });

    console.log("CHAPTER PDF CREATED:", chapterPdf);

    return res.status(201).json({
      success: true,
      message: "Chapter PDF created successfully",
      data: chapterPdf,
    });

  } catch (error) {
    console.error("CHAPTER PDF ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to save chapter PDF",
      error: error.message,
    });
  }
});

router.get("/", async (req, res) => {
  try {
    console.log("QUERY:", req.query);

    const filter = {};

    // ==============================
    // PRODUCT FILTER
    // ==============================

    if (req.query.productId) {
      const productId = String(req.query.productId).trim();

      if (!mongoose.isValidObjectId(productId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid productId",
        });
      }

      filter.product = productId;
    }

    // ==============================
    // MODULE FILTER
    // ==============================

    if (req.query.moduleId) {
      const moduleId = String(req.query.moduleId).trim();

      if (!mongoose.isValidObjectId(moduleId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid moduleId",
        });
      }

      filter.moduleId = moduleId;
    }

    // ==============================
    // COURSE NAME FILTER
    // ==============================

    if (req.query.courseName) {
      filter.courseName = String(req.query.courseName).trim();
    }

    // ==============================
    // CHAPTER TITLE FILTER
    // ==============================

    if (req.query.chapterTitle) {
      filter.chapterTitle = String(req.query.chapterTitle).trim();
    }

    // ==============================
    // PUBLISHED FILTER
    // ==============================

    if (req.query.isPublished !== undefined) {
      filter.isPublished =
        String(req.query.isPublished).toLowerCase() === "true";
    }

    // ==============================
    // GET CHAPTER PDFs
    // ==============================

    const chapterPdfs = await ChapterPdf.find(filter)
      .populate("product")
      .sort({
        order: 1,
        createdAt: -1,
      })
      .lean();

    // ==============================
    // ADD FULL PDF URL
    // ==============================

    const data = chapterPdfs.map((item) => {
      const fileName = item.pdf?.name || "";

      const pdfUrl = fileName
        ? `http://skyllabus.online/cdn?file=${encodeURIComponent(fileName)}`
        : "";

      const thumbUrl = item.pdf?.thumb
        ? `http://skyllabus.online${item.pdf.thumb}`
        : "";

      return {
        ...item,

        pdf: {
          ...(item.pdf || {}),

          url: pdfUrl,

          thumbUrl: thumbUrl,
        },

        // Easy access for Flutter
        pdfUrl: pdfUrl,
      };
    });

    // ==============================
    // RESPONSE
    // ==============================

    return res.status(200).json({
      success: true,
      count: data.length,
      data: data,
    });

  } catch (error) {
    console.error("GET CHAPTER PDF ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to get chapter PDFs",
      error: error.message,
    });
  }
});

module.exports = router;