const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const stagingDirectory = path.join(os.tmpdir(), "skyllabus-content-staging");
fs.mkdirSync(stagingDirectory, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, stagingDirectory),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname)}`),
});

const pdfUpload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === "application/pdf" || path.extname(file.originalname).toLowerCase() === ".pdf";
    return ok ? cb(null, true) : cb(new Error("Chapter file must be a PDF"));
  },
}).single("pdf");

module.exports = { pdfUpload };
