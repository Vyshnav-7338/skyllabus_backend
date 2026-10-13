const mongoose = require("mongoose");
const { normalizeMoney } = require("../utils/money");

const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    availableBalance: { type: Number, min: 0, default: 0, set: normalizeMoney },
    totalCredits: { type: Number, min: 0, default: 0, set: normalizeMoney },
    totalDebits: { type: Number, min: 0, default: 0, set: normalizeMoney },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Wallet", walletSchema);
