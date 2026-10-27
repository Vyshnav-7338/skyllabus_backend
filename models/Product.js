const mongoose = require("mongoose");
const { normalizeMoney } = require("../utils/money");
const fileSchema = require("./fileSchema");

const courseVideoSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: "" },
  youtubeUrl: { type: String, required: true, trim: true },
  duration: { type: String, trim: true, default: "" },
  isPublished: { type: Boolean, default: true },
}, { timestamps: true });

const productSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
  shortDescription: { type: String, required: true, trim: true },
  description: { type: String, required: true, trim: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true, index: true },
  thumbnail: { type: fileSchema, default: null },
  banner: { type: fileSchema, default: null },
  instructorName: { type: String, required: true, trim: true },
  originalPrice: { type: Number, min: 0, default: 0, set: normalizeMoney },
  price: { type: Number, min: 0, required: true, set: normalizeMoney },
  offerPrice: { type: Number, min: 0, default: 0, set: normalizeMoney },
  currency: { type: String, required: true, trim: true, uppercase: true },
  level: { type: String, required: true, trim: true },
  duration: { type: String, trim: true, default: "" },
  certificateAvailable: { type: Boolean, default: true },
  incomeOpportunity: { type: String, trim: true, default: "" },
  tags: [{ type: String, trim: true }],
  isFeatured: { type: Boolean, default: false, index: true },
  isPublished: { type: Boolean, default: false, index: true },
  isActive: { type: Boolean, default: true, index: true },
  enrollmentCount: { type: Number, min: 0, default: 0 },
  courseVideo: { type: courseVideoSchema, default: null },
}, { timestamps: true });

module.exports = mongoose.model("Product", productSchema);
