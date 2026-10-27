const mongoose = require("mongoose");

const giveawayEntrySchema = new mongoose.Schema(
  {
    giveaway: { type: mongoose.Schema.Types.ObjectId, ref: "Giveaway", required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    joinedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["joined", "winner", "cancelled"], default: "joined" },
  },
  { timestamps: true },
);

giveawayEntrySchema.index({ giveaway: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("GiveawayEntry", giveawayEntrySchema);
