const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const Product = require("../models/Product");
const ModuleAssessment = require("../models/ModuleAssessment");
const Enrollment = require("../models/Enrollment");
const User = require("../models/User");
const { sendApiError } = require("../utils/api-error");

const router = express.Router();

// =====================================================
// GET USER FROM TOKEN
// =====================================================
async function userFromRequest(req) {
  const authHeader = String(req.headers.authorization || "");

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  try {
    const token = authHeader.slice(7);

    const payload = jwt.verify(
      token,
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
    const user = await userFromRequest(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
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
    return sendApiError(res, error, {
      fallbackMessage: "Authentication failed",
    });
  }
}

// =====================================================
// FIND COURSE / PRODUCT
// =====================================================
async function findProduct(req) {
  const productId = String(
    req.query.productId ||
    req.body?.productId ||
    ""
  ).trim();

  // Find using MongoDB ID
  if (
    productId &&
    mongoose.isValidObjectId(productId)
  ) {
    return await Product.findById(productId);
  }

  // Otherwise find using course name
  const courseName = String(
    req.query.courseName ||
    req.body?.courseName ||
    ""
  ).trim();

  if (!courseName) {
    return null;
  }

  return await Product.findOne({
    title: courseName,
  });
}

// =====================================================
// FIND MODULE INSIDE COURSE
// =====================================================
function findModule(product, moduleId) {
  if (!moduleId) {
    return null;
  }

  return (product.modules || []).find(
    (module) =>
      String(module._id) === String(moduleId)
  );
}

// =====================================================
// FIND EXISTING MODULE OR CREATE NEW MODULE
// =====================================================
async function resolveOrCreateModule(
  product,
  body
) {
  // ---------------------------------------------
  // 1. Try moduleId first
  // ---------------------------------------------
  let module = null;

  if (body.moduleId) {
    module = findModule(
      product,
      body.moduleId
    );
  }

  if (module) {
    return module;
  }

  // ---------------------------------------------
  // 2. Get module title
  // ---------------------------------------------
  const moduleTitle = String(
    body.moduleTitle ||
    body.moduleName ||
    body.title ||
    ""
  ).trim();

  if (!moduleTitle) {
    throw Object.assign(
      new Error("Module title is required"),
      {
        statusCode: 400,
      }
    );
  }

  // ---------------------------------------------
  // 3. Check whether module already exists
  // ---------------------------------------------
  const existingModule = (
    product.modules || []
  ).find(
    (item) =>
      String(item.title || "")
        .trim()
        .toLowerCase() ===
      moduleTitle.toLowerCase()
  );

  if (existingModule) {
    return existingModule;
  }

  // ---------------------------------------------
  // 4. Create new module
  // ---------------------------------------------
  const newModule =
    product.modules.create({
      title: moduleTitle,

      description: String(
        body.moduleDescription ||
        ""
      ).trim(),

      order: Number(
        body.moduleOrder ||
        product.modules.length + 1
      ),

      chapters: [],

      // Assessment itself is stored separately
      // in ModuleAssessment collection.
      assessment: null,

      isPublished:
        body.modulePublished !== false,
    });

  product.modules.push(newModule);

  product.markModified("modules");

  await product.save();

  return product.modules[
    product.modules.length - 1
  ];
}

// =====================================================
// NORMALIZE OPTIONS
//
// Supports:
//
// 1.
//
// options: [
//   "Option A",
//   "Option B",
//   "Option C",
//   "Option D"
// ]
//
// 2.
//
// options: {
//   a: "Option A",
//   b: "Option B",
//   c: "Option C",
//   d: "Option D"
// }
//
// =====================================================
function normalizeOptions(options) {
  // ---------------------------------------------
  // Array format
  // ---------------------------------------------
  if (Array.isArray(options)) {
    return options.map((option) =>
      String(option || "").trim()
    );
  }

  // ---------------------------------------------
  // Object format
  // ---------------------------------------------
  if (
    options &&
    typeof options === "object"
  ) {
    return [
      options.a,
      options.b,
      options.c,
      options.d,
    ]
      .filter(
        (option) =>
          option !== undefined &&
          option !== null
      )
      .map((option) =>
        String(option).trim()
      );
  }

  return [];
}

// =====================================================
// CONVERT ANSWER TO INDEX
//
// a -> 0
// b -> 1
// c -> 2
// d -> 3
//
// =====================================================
function answerLetterToIndex(answer) {
  if (
    answer === undefined ||
    answer === null
  ) {
    return null;
  }

  // Already numeric
  if (
    typeof answer === "number" &&
    Number.isInteger(answer)
  ) {
    return answer;
  }

  const value = String(answer)
    .trim()
    .toLowerCase();

  const answerMap = {
    a: 0,
    b: 1,
    c: 2,
    d: 3,
  };

  // a / b / c / d
  if (
    Object.prototype.hasOwnProperty.call(
      answerMap,
      value
    )
  ) {
    return answerMap[value];
  }

  // "0", "1", "2", "3"
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

// =====================================================
// NORMALIZE QUESTIONS
// =====================================================
function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) {
    throw Object.assign(
      new Error(
        "questions must be an array"
      ),
      {
        statusCode: 400,
      }
    );
  }

  if (rawQuestions.length === 0) {
    throw Object.assign(
      new Error(
        "At least one question is required"
      ),
      {
        statusCode: 400,
      }
    );
  }

  return rawQuestions.map(
    (questionData, index) => {
      // -----------------------------------------
      // QUESTION
      // -----------------------------------------
      const question = String(
        questionData.question ??
        questionData.prompt ??
        ""
      ).trim();

      if (!question) {
        throw Object.assign(
          new Error(
            `Question ${
              index + 1
            } requires question text`
          ),
          {
            statusCode: 400,
          }
        );
      }

      // -----------------------------------------
      // OPTIONS
      // -----------------------------------------
      const options =
        normalizeOptions(
          questionData.options
        );

      if (
        options.length < 2 ||
        options.some(
          (option) => !option
        )
      ) {
        throw Object.assign(
          new Error(
            `Question ${
              index + 1
            } needs at least 2 valid options`
          ),
          {
            statusCode: 400,
          }
        );
      }

      // -----------------------------------------
      // ANSWERS
      // -----------------------------------------
      let answers = [];

      // Existing backend format
      if (
        questionData.correctOptionIndexes !==
        undefined
      ) {
        answers =
          questionData.correctOptionIndexes;
      }

      // Alternative existing format
      else if (
        questionData.correctAnswers !==
        undefined
      ) {
        answers =
          questionData.correctAnswers;
      }

      // Single answer index
      else if (
        questionData.correctAnswerIndex !==
        undefined
      ) {
        answers = [
          questionData.correctAnswerIndex,
        ];
      }

      // NEW JSON FORMAT:
      //
      // answer: "a"
      // answer: "b"
      //
      else if (
        questionData.answer !== undefined
      ) {
        const answerIndex =
          answerLetterToIndex(
            questionData.answer
          );

        if (answerIndex !== null) {
          answers = [answerIndex];
        }
      }

      // Make sure array
      if (!Array.isArray(answers)) {
        answers = [answers];
      }

      // -----------------------------------------
      // Convert answer values
      // -----------------------------------------
      answers = answers
        .map((answer) => {
          // Support a/b/c/d even inside arrays
          const converted =
            answerLetterToIndex(answer);

          return converted;
        })
        .filter(
          (answer) =>
            answer !== null
        );

      // Remove duplicate indexes
      answers = [
        ...new Set(answers),
      ];

      // -----------------------------------------
      // Validate answer
      // -----------------------------------------
      if (
        answers.length === 0 ||
        answers.some(
          (answerIndex) =>
            !Number.isInteger(
              answerIndex
            ) ||
            answerIndex < 0 ||
            answerIndex >=
              options.length
        )
      ) {
        throw Object.assign(
          new Error(
            `Question ${
              index + 1
            } has an invalid answer key`
          ),
          {
            statusCode: 400,
          }
        );
      }

      return {
        question,

        options,

        correctOptionIndexes:
          answers,

        allowsMultipleSelections:
          questionData
            .allowsMultipleSelections ===
            true ||
          answers.length > 1,
      };
    }
  );
}

// =====================================================
// GET MODULE ASSESSMENTS
//
// GET:
// /api/module-assessments
//
// ?productId=xxx
//
// OR
//
// ?courseName=Personal Brand Strategist
//
// =====================================================
router.get("/", async (req, res) => {
  try {
    const product =
      await findProduct(req);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    const user =
      await userFromRequest(req);

    let allowed = false;

    // Admin can access
    if (
      user &&
      user.role === "admin"
    ) {
      allowed = true;
    }

    // Enrolled user can access
    if (
      user &&
      user.role !== "admin"
    ) {
      const enrollment =
        await Enrollment.exists({
          user: user._id,

          product:
            product._id,

          status: {
            $ne: "cancelled",
          },
        });

      if (enrollment) {
        allowed = true;
      }
    }

    if (!allowed) {
      return res.status(403).json({
        success: false,
        message:
          "Enroll in this course to view assessments",
      });
    }

    // -------------------------------------------
    // Load assessments
    // -------------------------------------------
    const assessments =
      await ModuleAssessment.find({
        product:
          product._id,

        isPublished: true,
      }).lean();

    const assessmentByModule =
      new Map(
        assessments.map(
          (assessment) => [
            String(
              assessment.moduleId
            ),

            assessment,
          ]
        )
      );

    // -------------------------------------------
    // Build module response
    // -------------------------------------------
    const modules = (
      product.modules || []
    )
      .filter(
        (module) =>
          module.isPublished !==
          false
      )
      .sort(
        (a, b) =>
          Number(a.order || 0) -
          Number(b.order || 0)
      )
      .map((module) => {
        const assessment =
          assessmentByModule.get(
            String(module._id)
          );

        // Only return modules
        // containing assessment
        if (!assessment) {
          return null;
        }

        return {
          _id:
            module._id,

          title:
            module.title,

          description:
            module.description,

          order:
            module.order,

          isPublished:
            module.isPublished,

          // PDF/chapter data comes from
          // separate API
          chapters: [],

          assessment: {
            _id:
              assessment._id,

            title:
              assessment.title,

            description:
              assessment.description,

            passingPercentage:
              assessment.passingPercentage,

            questions:
              assessment.questions,

            isPublished:
              assessment.isPublished,
          },
        };
      })
      .filter(Boolean);

    return res.json({
      success: true,

      data: {
        productId:
          product._id,

        courseName:
          product.title,

        modules,
      },
    });
  } catch (error) {
    return sendApiError(
      res,
      error,
      {
        fallbackMessage:
          "Unable to load module assessments",
      }
    );
  }
});

// =====================================================
// CREATE / UPDATE MODULE ASSESSMENT
//
// POST:
// /api/module-assessments
//
// =====================================================
router.post(
  "/",
  async (req, res) => {
    try {
      // -----------------------------------------
      // Find course
      // -----------------------------------------
      const product =
        await findProduct(req);

      if (!product) {
        return res.status(404).json({
          success: false,
          message:
            "Course not found",
        });
      }

      // -----------------------------------------
      // Create / find module
      // -----------------------------------------
      const module =
        await resolveOrCreateModule(
          product,
          req.body
        );

      // -----------------------------------------
      // Assessment body
      // -----------------------------------------
      const input =
        req.body.assessment ||
        req.body;

      // -----------------------------------------
      // Normalize questions
      // -----------------------------------------
      const questions =
        normalizeQuestions(
          input.questions || []
        );

      // -----------------------------------------
      // Passing percentage
      // -----------------------------------------
      let passingPercentage =
        Number(
          input.passingPercentage ??
          input.passingScore ??
          50
        );

      if (
        !Number.isFinite(
          passingPercentage
        ) ||
        passingPercentage < 0 ||
        passingPercentage > 100
      ) {
        return res.status(400).json({
          success: false,
          message:
            "passingPercentage must be between 0 and 100",
        });
      }

      // -----------------------------------------
      // Save assessment
      // -----------------------------------------
      const assessment =
        await ModuleAssessment
          .findOneAndUpdate(
            {
              product:
                product._id,

              moduleId:
                module._id,
            },

            {
              product:
                product._id,

              moduleId:
                module._id,

              moduleTitle:
                module.title,

              title: String(
                input.title ||
                `${module.title} Assessment`
              ).trim(),

              description:
                String(
                  input.description ||
                  ""
                ).trim(),

              passingPercentage,

              questions,

              isPublished:
                input.isPublished !==
                false,
            },

            {
              upsert: true,
              new: true,
              runValidators: true,
              setDefaultsOnInsert: true,
            }
          );

      // -----------------------------------------
      // Response
      // -----------------------------------------
      return res
        .status(201)
        .json({
          success: true,

          message:
            "Module and assessment saved",

          data: {
            assessment,

            module: {
              _id:
                module._id,

              title:
                module.title,

              description:
                module.description,

              order:
                module.order,
            },
          },
        });
    } catch (error) {
      return sendApiError(
        res,
        error,
        {
          fallbackMessage:
            "Unable to save module assessment",
        }
      );
    }
  }
);

// =====================================================
// DELETE ASSESSMENT
//
// DELETE:
// /api/module-assessments/:id
//
// =====================================================
router.delete(
  "/:id",
  requireAdmin,
  async (req, res) => {
    try {
      if (
        !mongoose.isValidObjectId(
          req.params.id
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid assessment ID",
        });
      }

      const assessment =
        await ModuleAssessment
          .findByIdAndDelete(
            req.params.id
          );

      if (!assessment) {
        return res.status(404).json({
          success: false,
          message:
            "Assessment not found",
        });
      }

      return res.json({
        success: true,
        message:
          "Assessment deleted",
      });
    } catch (error) {
      return sendApiError(
        res,
        error,
        {
          fallbackMessage:
            "Unable to delete assessment",
        }
      );
    }
  }
);

module.exports = router;