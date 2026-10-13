const mongoose = require("mongoose");

module.exports = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    thumb: { type: String, trim: true, default: "" },
    size: { type: Number, min: 0, default: 0 },
    mime: { type: String, trim: true, default: "application/octet-stream" },
    md5: { type: String, trim: true, default: "" },
    orgname: { type: String, trim: true, default: "" },
  },
  { _id: false },
);
