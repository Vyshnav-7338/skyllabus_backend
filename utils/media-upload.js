const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const stagingDirectory = path.join(os.tmpdir(), "skyllabus-upload-staging");
fs.mkdirSync(stagingDirectory, { recursive: true });

function isImageField(name) { return name === "thumbnail" || name === "banner"; }

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
