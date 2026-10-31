const mongoose = require("mongoose");
const fileSchema = require("./fileSchema");

const chapterPdfSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
  moduleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  moduleTitle: { type: String, required: true, trim: true },
  chapterTitle: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: "" },
  order: { type: Number, min: 0, default: 0 },
  pdf: { type: Object, required: true },
  isPublished: { type: Boolean, default: true, index: true },
}, { timestamps: true });

chapterPdfSchema.index({ product: 1, moduleId: 1, chapterId: 1 }, { unique: true });
module.exports = mongoose.model("ChapterPdf", chapterPdfSchema);
