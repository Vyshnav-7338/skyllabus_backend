const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true },
  options: {
    type: [{ type: String, trim: true }],
    validate: { validator: (v) => Array.isArray(v) && v.length >= 2 && v.every((x) => String(x || "").trim()), message: "Each question needs at least 2 options" },
  },
  correctOptionIndexes: { type: [{ type: Number, min: 0 }], required: true },
  allowsMultipleSelections: { type: Boolean, default: false },
}, { timestamps: true });

const moduleAssessmentSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
  moduleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  moduleTitle: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true, default: "" },
  passingPercentage: { type: Number, min: 0, max: 100, default: 50 },
  questions: { type: [questionSchema], default: [] },
  isPublished: { type: Boolean, default: true, index: true },
}, { timestamps: true });

moduleAssessmentSchema.index({ product: 1, moduleId: 1 }, { unique: true });
module.exports = mongoose.model("ModuleAssessment", moduleAssessmentSchema);
