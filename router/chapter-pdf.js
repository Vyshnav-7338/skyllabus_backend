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



router.post(
  "/",

  async (req, res) => {
    try {
      console.log("BODY:", req.body);
      console.log("FILES:", req.files);

      const files = req.files || {};

      if (!files.pdf || !files.pdf.length) {
        return res.status(400).json({
          success: false,
          message: "PDF file is required",
        });
      }

      const body = req.body;

      body.pdf = await futils.getFileObject(
        files["pdf"]
      );

      console.log("PDF:", body.pdf);

      // continue your ChapterPdf save here...

    } catch (error) {
      console.error(
        "CHAPTER PDF ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message: "Unable to save chapter PDF",
        error: error.message,
      });
    }
  }
);
module.exports = router;