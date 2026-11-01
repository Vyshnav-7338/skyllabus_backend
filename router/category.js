const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const Category = require("../models/Category");
const Product = require("../models/Product");
const User = require("../models/User");
const { sendApiError } = require("../utils/api-error");
const futils = require("../utils/fileutils");
const { imageUpload } = require("../utils/media-upload");
const { removeIfUnreferenced } = require("../utils/media-references");
JWT_SECRET='local-development-secret-change-before-production'

const router = express.Router();

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return value === true || value === "true" || value === "1" || value === 1;
}

async function requireAdmin(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return res.status(401).json({ success: false, message: "Authentication required" });
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ success: false, message: "User no longer exists" });
    if (user.role !== "admin") return res.status(403).json({ success: false, message: "Admin access required" });
    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

router.get("/", async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === "true";
    if (includeInactive) {
      return requireAdmin(req, res, async () => {
        const categories = await Category.find().sort({ sortOrder: 1, name: 1 });
        return res.json({ success: true, data: categories });
      });
    }
    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
    return res.json({ success: true, data: categories });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load categories" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid category ID" });
    }
    const category = await Category.findOne({ _id: req.params.id, isActive: true });
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    return res.json({ success: true, data: category });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to load category" });
  }
});

router.post("/", requireAdmin, imageUpload, async (req, res) => {
  let uploaded;
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Category name is required" });
    const slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).json({ success: false, message: "A valid category slug is required" });
    uploaded = req.file ? await futils.getFileObject(req.file) : null;
    const category = await Category.create({
      name,
      slug,
      description: String(req.body.description || "").trim(),
      image: uploaded,
      icon: String(req.body.icon || "school").trim(),
      isActive: toBoolean(req.body.isActive, true),
      sortOrder: Number(req.body.sortOrder || 0),
    });
    const persisted = await Category.findById(category._id);
    if (!persisted?._id) throw new Error("Category save completed without a persisted record");
    return res.status(201).json({ success: true, message: "Category created successfully", data: persisted });
  } catch (error) {
    if (uploaded) await futils.removeFileObject(uploaded);
    return sendApiError(res, error, {
      duplicateMessage: "Category name or slug already exists",
      fallbackMessage: "Unable to create category",
    });
  } finally { await futils.removeIncoming(req.file ? [req.file] : []); }
});

router.put("/:id", requireAdmin, imageUpload, async (req, res) => {
  let uploaded;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid category ID" });
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    if (req.body.name !== undefined) category.name = String(req.body.name).trim();
    if (req.body.slug !== undefined || req.body.name !== undefined) category.slug = slugify(req.body.slug || category.name);
    if (req.body.description !== undefined) category.description = String(req.body.description).trim();
    const oldImage = category.image?.toObject?.() || category.image;
    if (req.file) {
      uploaded = await futils.getFileObject(req.file);
      category.image = uploaded;
    }
    if (req.body.icon !== undefined) category.icon = String(req.body.icon).trim();
    if (req.body.isActive !== undefined) category.isActive = toBoolean(req.body.isActive);
    if (req.body.sortOrder !== undefined) category.sortOrder = Number(req.body.sortOrder || 0);
    await category.save();
    if (uploaded && oldImage) await removeIfUnreferenced(oldImage);
    return res.json({ success: true, message: "Category updated successfully", data: category });
  } catch (error) {
    if (uploaded) await futils.removeFileObject(uploaded);
    return sendApiError(res, error, {
      duplicateMessage: "Category name or slug already exists",
      fallbackMessage: "Unable to update category",
    });
  } finally { await futils.removeIncoming(req.file ? [req.file] : []); }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid category ID" });
    if (await Product.exists({ category: req.params.id })) {
      return res.status(409).json({ success: false, message: "Delete or move this category's products first" });
    }
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    if (category.image) await removeIfUnreferenced(category.image);
    return res.json({ success: true, message: "Category deleted successfully", data: category });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Unable to delete category" });
  }
});

module.exports = router;
