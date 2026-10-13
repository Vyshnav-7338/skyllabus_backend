const mongoose = require("mongoose");
const { normalizeMoney } = require("../utils/money");

const walletTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["CREDIT", "DEBIT"], required: true, index: true },
    transactionType: {
      type: String,
      enum: ["REFERRAL_REWARD", "COURSE_ENROLLMENT", "ADMIN_ADJUSTMENT"],
      required: true,
      index: true,
    },
    amount: { type: Number, min: 0, required: true, set: normalizeMoney },
    referralLevel: { type: Number, min: 1, max: 5, default: null },
    referredUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    balanceBefore: { type: Number, min: 0, required: true, set: normalizeMoney },
    balanceAfter: { type: Number, min: 0, required: true, set: normalizeMoney },
    description: { type: String, required: true, trim: true },
    reference: { type: String, trim: true, default: "" },
    eventKey: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: true },
);

walletTransactionSchema.index({ user: 1, createdAt: -1 });
walletTransactionSchema.index(
  { referredUser: 1, user: 1, referralLevel: 1, transactionType: 1 },
  { unique: true, partialFilterExpression: { transactionType: "REFERRAL_REWARD" } },
);

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);
