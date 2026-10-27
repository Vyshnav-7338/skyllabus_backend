const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
    profilePhoto: { type: mongoose.Schema.Types.Mixed, default: null },
    referralCode: { type: String, required: true, unique: true, uppercase: true, index: true, immutable: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true, index: true },
    level: { type: Number, min: 1, default: 1 },
    xp: { type: Number, min: 0, default: 0 },
    nextLevelXp: { type: Number, min: 1, default: 1000 },
  },
  { timestamps: true },
);

userSchema.pre("save", async function hashPassword() {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = function comparePassword(password) {
  return bcrypt.compare(password, this.password);
};

userSchema.set("toJSON", {
  transform: (_document, result) => {
    delete result.password;
    delete result.__v;
    return result;
  },
});

module.exports = mongoose.model("User", userSchema);
