const express = require('express');
const router = express.Router();
const trust = require('../services/trustService');
const { auth, adminAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

const handleError = (error, res) => {
  if (error instanceof trust.TrustUnavailable) return res.status(503).json({ success: false, code: error.code, message: error.message });
  if (error instanceof trust.TrustError) return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  console.error('Trust route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
};

router.post('/signals', auth, async (req, res) => {
  try {
    const { signalType, signalValue } = req.body || {};
    if (!signalType || !signalValue) return res.status(400).json({ success: false, code: 'invalid_input', message: 'signalType and signalValue required' });
    const row = await trust.recordIdentitySignal(req.user.id, signalType, signalValue);
    res.status(201).json({ success: true, signal: row });
  } catch (e) { handleError(e, res); }
});

router.get('/clusters', auth, adminAuth, async (req, res) => {
  try {
    const { signalType, signalValue } = req.query;
    if (!signalType || !signalValue) return res.status(400).json({ success: false, code: 'invalid_input', message: 'signalType and signalValue required' });
    const rows = await trust.findCluster(signalType, signalValue);
    res.json({ success: true, members: rows });
  } catch (e) { handleError(e, res); }
});

router.get('/banned/:userId', auth, adminAuth, async (req, res) => {
  try {
    const banned = await trust.isBanned(req.params.userId);
    res.json({ success: true, banned });
  } catch (e) { handleError(e, res); }
});

router.post('/bans', auth, adminAuth, async (req, res) => {
  try {
    const { userId, reason, scope, expiresAt } = req.body || {};
    if (!userId || !reason) return res.status(400).json({ success: false, code: 'invalid_input', message: 'userId and reason required' });
    const ban = await trust.banAccount({ userId, reason, scope, bannedBy: req.user.id, expiresAt });
    res.status(201).json({ success: true, ban });
  } catch (e) { handleError(e, res); }
});

router.post('/bans/:id/lift', auth, adminAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid ban id' });
    const ban = await trust.liftBan(req.params.id, req.user.id);
    res.json({ success: true, ban });
  } catch (e) { handleError(e, res); }
});

router.post('/fingerprints', auth, async (req, res) => {
  try {
    const { fingerprint, userAgent, ipAddress } = req.body || {};
    if (!fingerprint) return res.status(400).json({ success: false, code: 'invalid_input', message: 'fingerprint required' });
    const row = await trust.recordFingerprint(fingerprint, req.user.id, userAgent, ipAddress);
    res.status(201).json({ success: true, fingerprint: row });
  } catch (e) { handleError(e, res); }
});

router.get('/alerts', auth, adminAuth, async (req, res) => {
  try {
    const alerts = await trust.listAlerts({ status: req.query.status, limit: Number(req.query.limit) || 50 });
    res.json({ success: true, alerts });
  } catch (e) { handleError(e, res); }
});

router.post('/alerts', auth, adminAuth, async (req, res) => {
  try {
    const { userId, clusterId, alertType, severity, details } = req.body || {};
    if (!alertType) return res.status(400).json({ success: false, code: 'invalid_input', message: 'alertType required' });
    const alert = await trust.raiseAlert({ userId, clusterId, alertType, severity, details });
    res.status(201).json({ success: true, alert });
  } catch (e) { handleError(e, res); }
});

router.post('/alerts/:id/resolve', auth, adminAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid alert id' });
    const alert = await trust.resolveAlert(req.params.id, req.user.id, req.body?.status || 'resolved');
    res.json({ success: true, alert });
  } catch (e) { handleError(e, res); }
});

// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error instanceof trust.TrustUnavailable || error instanceof trust.TrustError) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
  console.error('Trust route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
});

module.exports = router;
