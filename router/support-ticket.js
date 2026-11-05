const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const User = require('../models/User');
const SupportTicket = require('../models/SupportTicket');
const router = express.Router();
const uploadDir = path.join(__dirname, '..', 'public', 'ticket-uploads');
const futils = require("../utils/fileutils");

async function auth(req, res, next) {
  try {
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Authentication required' });
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'local-development-secret-change-before-production');
    const user = await User.findById(payload.id);
    if (!user || user.status === 'disabled') return res.status(401).json({ success: false, message: 'User unavailable' });
    req.user = user;
    next();
  } catch (_) { return res.status(401).json({ success: false, message: 'Invalid token' }); }
}
router.use(auth);
router.post('/', async (req, res) => {
  let filePath;
  try {
    const message = String(req.body?.message || '').trim();
    if (!message || message.length > 3000) return res.status(400).json({ success: false, message: 'Message is required (max 3000 characters)' });
    const file = req.files?.photo;
    if (Array.isArray(file)) return res.status(400).json({ success: false, message: 'Only one photo allowed' });
   
   
         const photo = await futils.getFileObject(file);
     
    
    const ticket = await SupportTicket.create({ user: req.user._id, message, photo});
    return res.status(201).json({ success: true, message: 'Support ticket submitted', data: ticket });
  } catch (error) {
    if (filePath) await fs.unlink(filePath).catch(() => {});
    console.error('Ticket creation failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to submit ticket' });
  }
});
router.get('/mine', async (req, res) => {
  const data = await SupportTicket.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ success: true, data });
});
router.get('/admin', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
  const data = await SupportTicket.find().populate('user', 'name email phone').sort({ createdAt: -1 }).limit(200).lean();
  res.json({ success: true, data });
});
router.patch('/admin/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
  const status = String(req.body?.status || '');
  if (!['OPEN', 'IN_PROGRESS', 'RESOLVED'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
  const adminNote = String(req.body?.adminNote || '').slice(0, 3000);
  const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, { status, adminNote }, { new: true, runValidators: true });
  if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
  res.json({ success: true, data: ticket });
});
module.exports = router;
