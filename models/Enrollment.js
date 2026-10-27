const mongoose = require("mongoose");

const enrollmentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    enrolledAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["active", "completed", "cancelled"], default: "active", index: true },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    lastAccessedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

enrollmentSchema.index({ user: 1, product: 1 }, { unique: true });

module.exports = mongoose.model("Enrollment", enrollmentSchema);
