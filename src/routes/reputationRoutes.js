const express = require('express');
const router = express.Router();
const rep = require('../services/reputationService');
const { auth, adminAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

const handleError = (error, res) => {
  if (error instanceof rep.ReputationUnavailable) return res.status(503).json({ success: false, code: error.code, message: error.message });
  if (error instanceof rep.ReputationError) return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  console.error('Reputation route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
};

router.post('/reviews', auth, async (req, res) => {
  try {
    const { rentalId, revieweeId, direction, rating, title, body } = req.body || {};
    if (!rentalId || !revieweeId || !direction || !rating) return res.status(400).json({ success: false, code: 'invalid_input', message: 'rentalId, revieweeId, direction, rating required' });
    const review = await rep.createReview({ rentalId, reviewerId: req.user.id, revieweeId, direction, rating, title, body });
    res.status(201).json({ success: true, review });
  } catch (e) { handleError(e, res); }
});

router.get('/reviews/:userId', async (req, res) => {
  try {
    const reviews = await rep.reviewsForUser(req.params.userId);
    const stats = await rep.averageRating(req.params.userId);
    res.json({ success: true, reviews, stats });
  } catch (e) { handleError(e, res); }
});

router.post('/disputes', auth, async (req, res) => {
  try {
    const { rentalId, against, reason } = req.body || {};
    if (!reason) return res.status(400).json({ success: false, code: 'invalid_input', message: 'reason required' });
    const dispute = await rep.openDispute({ rentalId, openedBy: req.user.id, against, reason });
    res.status(201).json({ success: true, dispute });
  } catch (e) { handleError(e, res); }
});

router.get('/disputes', auth, adminAuth, async (req, res) => {
  try {
    const disputes = await rep.listDisputes({ status: req.query.status, limit: Number(req.query.limit) || 50 });
    res.json({ success: true, disputes });
  } catch (e) { handleError(e, res); }
});

router.post('/disputes/:id/resolve', auth, adminAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid dispute id' });
    const dispute = await rep.resolveDispute(req.params.id, {
      status: req.body?.status || 'resolved', resolution: req.body?.resolution,
      refundAmountMinor: req.body?.refundAmountMinor, resolvedBy: req.user.id
    });
    res.json({ success: true, dispute });
  } catch (e) { handleError(e, res); }
});

router.use((error, req, res, next) => {
  if (error instanceof rep.ReputationUnavailable || error instanceof rep.ReputationError) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
  console.error('Reputation route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
});

module.exports = router;
