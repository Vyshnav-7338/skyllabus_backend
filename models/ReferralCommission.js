const mongoose = require("mongoose");
const { normalizeMoney } = require("../utils/money");

const referralCommissionSchema = new mongoose.Schema(
  {
    beneficiary: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sourceUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    level: { type: Number, min: 1, max: 5, required: true },
    amount: { type: Number, min: 0, required: true, set: normalizeMoney },
    triggerType: { type: String, enum: ["signup"], default: "signup", required: true },
    status: { type: String, enum: ["credited"], default: "credited", required: true },
  },
  { timestamps: true },
);

referralCommissionSchema.index(
  { beneficiary: 1, sourceUser: 1, level: 1, triggerType: 1 },
  { unique: true },
);

module.exports = mongoose.model("ReferralCommission", referralCommissionSchema);
