const mongoose = require("mongoose");

const withdrawalRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  amount: { type: Number, required: true, min: 1000 },
  method: { type: String, enum: ["UPI", "BANK"], required: true },
  payoutDetails: {
    upiId: { type: String, trim: true, default: "" },
    accountHolderName: { type: String, trim: true, default: "" },
    accountNumber: { type: String, trim: true, default: "" },
    ifscCode: { type: String, trim: true, uppercase: true, default: "" },
    bankName: { type: String, trim: true, default: "" },
  },
  status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED", "PAID"], default: "PENDING", index: true },
}, { timestamps: true });

module.exports = mongoose.model("WithdrawalRequest", withdrawalRequestSchema);
