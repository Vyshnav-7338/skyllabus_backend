const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const stagingDirectory = path.join(os.tmpdir(), "skyllabus-upload-staging");
fs.mkdirSync(stagingDirectory, { recursive: true });

function isImageField(name) { return name === "thumbnail" || name === "banner"; }
function isChapterPdfField(name) { return /^chapterPdf_\d+_\d+$/.test(name) || /^noteFile_\d+_\d+(?:_\d+)?$/.test(name); }
function isAssessmentJsonField(name) { return /^assessmentJson_\d+$/.test(name) || /^assessmentFile_\d+$/.test(name); }

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, stagingDirectory),
  filename: (_req, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`),
});

const productUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 100 },
  fileFilter: (_req, file, callback) => {
    if (isImageField(file.fieldname)) {
      return /^image\/(jpeg|png|webp)$/.test(file.mimetype) ? callback(null, true) : callback(new Error("Images must be JPEG, PNG, or WebP"));
    }
    if (isChapterPdfField(file.fieldname)) {
      return file.mimetype === "application/pdf" ? callback(null, true) : callback(new Error("Chapter notes must be PDF files"));
    }
    if (isAssessmentJsonField(file.fieldname)) {
      const ok = file.mimetype === "application/json" || file.mimetype === "text/json" || file.mimetype === "text/plain" || /\.json$/i.test(file.originalname || "");
      return ok ? callback(null, true) : callback(new Error("Assessment must be a JSON file"));
    }
    return callback(new Error(`Unexpected upload field: ${file.fieldname}`));
  },
}).any();

const imageUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => /^image\/(jpeg|png|webp)$/.test(file.mimetype) ? callback(null, true) : callback(new Error("Images must be JPEG, PNG, or WebP")),
}).single("image");

const profilePhotoUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => /^image\/(jpeg|png|webp)$/.test(file.mimetype) ? callback(null, true) : callback(new Error("Images must be JPEG, PNG, or WebP")),
}).single("photo");

module.exports = { productUpload, imageUpload, profilePhotoUpload };
