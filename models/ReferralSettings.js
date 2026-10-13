const mongoose = require("mongoose");
const { normalizeMoney } = require("../utils/money");

const referralSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true, immutable: true },
    level1Reward: { type: Number, min: 0, default: 200, set: normalizeMoney },
    level2Reward: { type: Number, min: 0, default: 100, set: normalizeMoney },
    level3Reward: { type: Number, min: 0, default: 50, set: normalizeMoney },
    level4Reward: { type: Number, min: 0, default: 25, set: normalizeMoney },
    level5Reward: { type: Number, min: 0, default: 25, set: normalizeMoney },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ReferralSettings", referralSettingsSchema);
