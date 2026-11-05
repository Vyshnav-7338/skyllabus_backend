const mongoose = require('mongoose');
const supportTicketSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  message: { type: String, required: true, trim: true, maxlength: 3000 },
  photo: { type: Object, default: null },
  status: { type: String, enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED'], default: 'OPEN', index: true },
  adminNote: { type: String, default: '', maxlength: 3000 },
}, { timestamps: true });
module.exports = mongoose.model('SupportTicket', supportTicketSchema);
