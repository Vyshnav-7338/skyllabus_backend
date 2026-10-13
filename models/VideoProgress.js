const mongoose = require("mongoose");

const videoProgressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    moduleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    chapterId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    videoId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    currentTime: { type: Number, min: 0, default: 0 },
    duration: { type: Number, min: 0, default: 0 },
    progressPercentage: { type: Number, min: 0, max: 100, default: 0 },
    started: { type: Boolean, default: true },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    lastWatchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

videoProgressSchema.index({ user: 1, product: 1, videoId: 1 }, { unique: true });

module.exports = mongoose.model("VideoProgress", videoProgressSchema);
