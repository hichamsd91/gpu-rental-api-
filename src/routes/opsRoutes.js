const express = require('express');
const router = express.Router();
const ops = require('../services/opsService');
const { auth, adminAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

const handleError = (error, res) => {
  if (error instanceof ops.OpsUnavailable) return res.status(503).json({ success: false, code: error.code, message: error.message });
  if (error instanceof ops.OpsError) return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  console.error('Ops route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
};

// Tickets (user-facing)
router.post('/tickets', auth, async (req, res) => {
  try {
    const { subject, body, priority } = req.body || {};
    if (!subject || !body) return res.status(400).json({ success: false, code: 'invalid_input', message: 'subject and body required' });
    const ticket = await ops.createTicket({ userId: req.user.id, subject, body, priority });
    res.status(201).json({ success: true, ticket });
  } catch (e) { handleError(e, res); }
});
router.get('/tickets', auth, async (req, res) => {
  try {
    const tickets = await ops.listTickets({ userId: req.user.id, status: req.query.status, limit: Number(req.query.limit) || 50 });
    res.json({ success: true, tickets });
  } catch (e) { handleError(e, res); }
});
router.get('/tickets/:id', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid ticket id' });
    const ticket = await ops.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, code: 'not_found', message: 'Ticket not found' });
    const messages = await ops.listTicketMessages(req.params.id, req.user.role === 'admin');
    res.json({ success: true, ticket, messages });
  } catch (e) { handleError(e, res); }
});
router.post('/tickets/:id/messages', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid ticket id' });
    const msg = await ops.addTicketMessage({ ticketId: req.params.id, authorId: req.user.id, body: req.body?.body, isInternal: req.user.role === 'admin' && req.body?.isInternal === true });
    res.status(201).json({ success: true, message: msg });
  } catch (e) { handleError(e, res); }
});
router.patch('/tickets/:id', auth, adminAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid ticket id' });
    const ticket = await ops.updateTicket(req.params.id, req.body || {});
    res.json({ success: true, ticket });
  } catch (e) { handleError(e, res); }
});
router.get('/tickets/admin/all', auth, adminAuth, async (req, res) => {
  try {
    const tickets = await ops.listTickets({ status: req.query.status, limit: Number(req.query.limit) || 50 });
    res.json({ success: true, tickets });
  } catch (e) { handleError(e, res); }
});

// Notifications
router.get('/notifications', auth, async (req, res) => {
  try {
    const notifications = await ops.listNotifications(req.user.id, { unreadOnly: req.query.unread === 'true', limit: Number(req.query.limit) || 50 });
    res.json({ success: true, notifications });
  } catch (e) { handleError(e, res); }
});
router.post('/notifications/:id/read', auth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid notification id' });
    const n = await ops.markNotificationRead(req.params.id, req.user.id);
    res.json({ success: true, notification: n });
  } catch (e) { handleError(e, res); }
});
router.post('/notifications/read-all', auth, async (req, res) => {
  try {
    await ops.markAllNotificationsRead(req.user.id);
    res.json({ success: true });
  } catch (e) { handleError(e, res); }
});

router.use((error, req, res, next) => {
  if (error instanceof ops.OpsUnavailable || error instanceof ops.OpsError) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
  console.error('Ops route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
});

module.exports = router;
