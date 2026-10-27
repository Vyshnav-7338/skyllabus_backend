const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    checkoutSessionId: { type: String, trim: true, unique: true, sparse: true },
    paymentIntentId: { type: String, trim: true, index: true, sparse: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, lowercase: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "cancelled", "expired"],
      default: "pending",
      index: true,
    },
    enrollmentStatus: {
      type: String,
      enum: ["pending", "completed", "not_created"],
      default: "pending",
    },
    paidAt: { type: Date, default: null },
    lastWebhookEventId: { type: String, trim: true, default: "" },
    activeKey: { type: String, trim: true, unique: true, sparse: true },
  },
  { timestamps: true },
);

paymentSchema.index({ user: 1, product: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
