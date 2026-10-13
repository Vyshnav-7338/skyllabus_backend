const mongoose = require("mongoose");

const giveawaySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    image: { type: mongoose.Schema.Types.Mixed, default: null },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    reward: { type: String, required: true, trim: true },
    target: { type: Number, min: 1, required: true },
    currentParticipants: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Giveaway", giveawaySchema);
