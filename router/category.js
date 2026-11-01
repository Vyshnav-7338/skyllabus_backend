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

const router = express.Router();

const JWT_SECRET =
  process.env.JWT_SECRET ||
  "local-development-secret-change-before-production";

// ============================================================
// HELPERS
// ============================================================

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return (
    value === true ||
    value === "true" ||
    value === "1" ||
    value === 1
  );
}

// ============================================================
// ADMIN AUTH
// ============================================================

async function requireAdmin(req, res, next) {
  try {
    const header = String(
      req.headers.authorization || ""
    );

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const token = header.slice(7).trim();

    const payload = jwt.verify(
      token,
      JWT_SECRET
    );

    const user = await User.findById(
      payload.id
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User no longer exists",
      });
    }

    if (user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
      });
    }

    req.user = user;

    next();
  } catch (error) {
    console.error(
      "CATEGORY AUTH ERROR:",
      error
    );

    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

// ============================================================
// GET ALL CATEGORIES
// ============================================================

router.get("/", async (req, res) => {
  try {
    const includeInactive =
      req.query.includeInactive === "true";

    // Admin list
    if (includeInactive) {
      return requireAdmin(
        req,
        res,
        async () => {
          try {
            const categories =
              await Category.find()
                .sort({
                  sortOrder: 1,
                  name: 1,
                });

            return res.json({
              success: true,
              data: categories,
            });
          } catch (error) {
            console.error(
              "CATEGORY ADMIN LIST ERROR:",
              error
            );

            return res.status(500).json({
              success: false,
              message:
                "Unable to load categories",
              error:
                process.env.NODE_ENV ===
                "development"
                  ? error.message
                  : undefined,
            });
          }
        }
      );
    }

    // Public active categories
    const categories =
      await Category.find({
        isActive: true,
      }).sort({
        sortOrder: 1,
        name: 1,
      });

    return res.json({
      success: true,
      data: categories,
    });
  } catch (error) {
    console.error(
      "CATEGORY LIST ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to load categories",
      error:
        process.env.NODE_ENV ===
        "development"
          ? error.message
          : undefined,
    });
  }
});

// ============================================================
// GET SINGLE CATEGORY
// ============================================================

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID",
      });
    }

    const category =
      await Category.findOne({
        _id: id,
        isActive: true,
      });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    return res.json({
      success: true,
      data: category,
    });
  } catch (error) {
    console.error(
      "GET CATEGORY ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to load category",
      error:
        process.env.NODE_ENV ===
        "development"
          ? error.message
          : undefined,
    });
  }
});

// ============================================================
// CREATE CATEGORY
// ============================================================

router.post(
  "/",
  requireAdmin,
  imageUpload,
  async (req, res) => {
    let uploaded = null;

    try {
      console.log(
        "CREATE CATEGORY BODY:",
        req.body
      );

      console.log(
        "CREATE CATEGORY FILE:",
        req.file
      );

      const name = String(
        req.body.name || ""
      ).trim();

      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            "Category name is required",
        });
      }

      const slug = slugify(
        req.body.slug || name
      );

      if (!slug) {
        return res.status(400).json({
          success: false,
          message:
            "A valid category slug is required",
        });
      }

      // ------------------------------------------
      // CHECK DUPLICATE
      // ------------------------------------------

      const duplicate =
        await Category.findOne({
          $or: [
            {
              name: {
                $regex: `^${escapeRegex(
                  name
                )}$`,
                $options: "i",
              },
            },
            {
              slug,
            },
          ],
        });

      if (duplicate) {
        return res.status(409).json({
          success: false,
          message:
            "Category name or slug already exists",
        });
      }

      // ------------------------------------------
      // IMAGE
      // ------------------------------------------

      if (req.file) {
        uploaded =
          await futils.getFileObject(
            req.file
          );
      }

      // ------------------------------------------
      // SORT ORDER
      // ------------------------------------------

      const sortOrder = Number(
        req.body.sortOrder || 0
      );

      if (Number.isNaN(sortOrder)) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid sort order",
        });
      }

      // ------------------------------------------
      // CREATE
      // ------------------------------------------

      const category =
        new Category({
          name,
          slug,

          description: String(
            req.body.description || ""
          ).trim(),

          image: uploaded,

          icon: String(
            req.body.icon || "school"
          ).trim(),

          isActive: toBoolean(
            req.body.isActive,
            true
          ),

          sortOrder,
        });

      await category.save();

      console.log(
        "CATEGORY CREATED:",
        category._id
      );

      return res.status(201).json({
        success: true,
        message:
          "Category created successfully",
        data: category,
      });
    } catch (error) {
      console.error(
        "CREATE CATEGORY ERROR:"
      );

      console.error(error);

      if (uploaded) {
        try {
          await futils.removeFileObject(
            uploaded
          );
        } catch (cleanupError) {
          console.error(
            "IMAGE CLEANUP ERROR:",
            cleanupError
          );
        }
      }

      return sendApiError(
        res,
        error,
        {
          duplicateMessage:
            "Category name or slug already exists",

          fallbackMessage:
            "Unable to create category",
        }
      );
    } finally {
      try {
        if (req.file) {
          await futils.removeIncoming([
            req.file,
          ]);
        }
      } catch (cleanupError) {
        console.error(
          "INCOMING FILE CLEANUP ERROR:",
          cleanupError
        );
      }
    }
  }
);

// ============================================================
// UPDATE CATEGORY
// ============================================================

router.put(
  "/:id",
  requireAdmin,
  imageUpload,
  async (req, res) => {
    let uploaded = null;

    try {
      const { id } = req.params;

      if (
        !mongoose.isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid category ID",
        });
      }

      const category =
        await Category.findById(id);

      if (!category) {
        return res.status(404).json({
          success: false,
          message:
            "Category not found",
        });
      }

      // ------------------------------------------
      // NAME
      // ------------------------------------------

      if (
        req.body.name !== undefined
      ) {
        const name = String(
          req.body.name
        ).trim();

        if (!name) {
          return res.status(400).json({
            success: false,
            message:
              "Category name is required",
          });
        }

        category.name = name;
      }

      // ------------------------------------------
      // SLUG
      // ------------------------------------------

      if (
        req.body.slug !== undefined ||
        req.body.name !== undefined
      ) {
        const slug = slugify(
          req.body.slug ||
            category.name
        );

        if (!slug) {
          return res.status(400).json({
            success: false,
            message:
              "Invalid category slug",
          });
        }

        category.slug = slug;
      }

      // ------------------------------------------
      // DESCRIPTION
      // ------------------------------------------

      if (
        req.body.description !==
        undefined
      ) {
        category.description =
          String(
            req.body.description || ""
          ).trim();
      }

      // ------------------------------------------
      // OLD IMAGE
      // ------------------------------------------

      const oldImage =
        category.image?.toObject?.() ||
        category.image;

      // ------------------------------------------
      // NEW IMAGE
      // ------------------------------------------

      if (req.file) {
        uploaded =
          await futils.getFileObject(
            req.file
          );

        category.image = uploaded;
      }

      // ------------------------------------------
      // ICON
      // ------------------------------------------

      if (
        req.body.icon !== undefined
      ) {
        category.icon = String(
          req.body.icon || "school"
        ).trim();
      }

      // ------------------------------------------
      // ACTIVE
      // ------------------------------------------

      if (
        req.body.isActive !==
        undefined
      ) {
        category.isActive =
          toBoolean(
            req.body.isActive
          );
      }

      // ------------------------------------------
      // SORT ORDER
      // ------------------------------------------

      if (
        req.body.sortOrder !==
        undefined
      ) {
        const sortOrder = Number(
          req.body.sortOrder
        );

        if (
          Number.isNaN(sortOrder)
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Invalid sort order",
          });
        }

        category.sortOrder =
          sortOrder;
      }

      await category.save();

      // ------------------------------------------
      // REMOVE OLD IMAGE
      // ------------------------------------------

      if (
        uploaded &&
        oldImage
      ) {
        try {
          await removeIfUnreferenced(
            oldImage
          );
        } catch (cleanupError) {
          console.error(
            "OLD IMAGE CLEANUP ERROR:",
            cleanupError
          );
        }
      }

      return res.json({
        success: true,
        message:
          "Category updated successfully",
        data: category,
      });
    } catch (error) {
      console.error(
        "UPDATE CATEGORY ERROR:"
      );

      console.error(error);

      if (uploaded) {
        try {
          await futils.removeFileObject(
            uploaded
          );
        } catch (cleanupError) {
          console.error(
            "IMAGE CLEANUP ERROR:",
            cleanupError
          );
        }
      }

      return sendApiError(
        res,
        error,
        {
          duplicateMessage:
            "Category name or slug already exists",

          fallbackMessage:
            "Unable to update category",
        }
      );
    } finally {
      try {
        if (req.file) {
          await futils.removeIncoming([
            req.file,
          ]);
        }
      } catch (cleanupError) {
        console.error(
          "INCOMING FILE CLEANUP ERROR:",
          cleanupError
        );
      }
    }
  }
);

// ============================================================
// DELETE CATEGORY
// ============================================================

router.delete(
  "/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (
        !mongoose.isValidObjectId(id)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid category ID",
        });
      }

      const productExists =
        await Product.exists({
          category: id,
        });

      if (productExists) {
        return res.status(409).json({
          success: false,
          message:
            "Delete or move this category's products first",
        });
      }

      const category =
        await Category.findByIdAndDelete(
          id
        );

      if (!category) {
        return res.status(404).json({
          success: false,
          message:
            "Category not found",
        });
      }

      if (category.image) {
        try {
          await removeIfUnreferenced(
            category.image
          );
        } catch (cleanupError) {
          console.error(
            "CATEGORY IMAGE CLEANUP ERROR:",
            cleanupError
          );
        }
      }

      return res.json({
        success: true,
        message:
          "Category deleted successfully",
        data: category,
      });
    } catch (error) {
      console.error(
        "DELETE CATEGORY ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to delete category",
      });
    }
  }
);

// ============================================================
// REGEX HELPER
// ============================================================

function escapeRegex(value) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

module.exports = router;