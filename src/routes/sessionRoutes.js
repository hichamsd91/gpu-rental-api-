// Phase 5 session routes — mounted at /api/sessions
const express = require('express');
const router = express.Router();
const sessions = require('../services/sessionService');
const { auth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

const handleError = (error, res) => {
  if (error instanceof sessions.SessionUnavailable) return res.status(503).json({ success: false, code: error.code, message: error.message });
  if (error instanceof sessions.SessionError) return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  console.error('Session route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
};

router.param('rentalId', (req, res, next, id) => {
  if (!isUuid(id)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid rental id' });
  next();
});

router.post('/:rentalId/heartbeat', auth, async (req, res) => {
  try {
    const hb = await sessions.recordHeartbeat(req.params.rentalId, req.body || {});
    res.json({ success: true, heartbeat: hb });
  } catch (e) { handleError(e, res); }
});

router.get('/:rentalId/heartbeat/latest', auth, async (req, res) => {
  try {
    const hb = await sessions.latestHeartbeat(req.params.rentalId);
    res.json({ success: true, heartbeat: hb });
  } catch (e) { handleError(e, res); }
});

router.post('/:rentalId/events', auth, async (req, res) => {
  try {
    const ev = await sessions.recordEvent(req.params.rentalId, req.body?.eventType || 'started', req.body?.payload || {});
    res.status(201).json({ success: true, event: ev });
  } catch (e) { handleError(e, res); }
});

router.get('/:rentalId/ssh-keys', auth, async (req, res) => {
  try {
    const keys = await sessions.activeSshKeys(req.params.rentalId);
    res.json({ success: true, keys });
  } catch (e) { handleError(e, res); }
});

router.post('/:rentalId/ssh-keys', auth, async (req, res) => {
  try {
    const key = await sessions.issueSshKey(req.params.rentalId, req.body?.publicKey, req.body?.expiresAt);
    res.status(201).json({ success: true, key });
  } catch (e) { handleError(e, res); }
});

router.delete('/:rentalId/ssh-keys', auth, async (req, res) => {
  try {
    const revoked = await sessions.revokeSshKeys(req.params.rentalId, req.body?.reason);
    res.json({ success: true, revoked });
  } catch (e) { handleError(e, res); }
});

router.post('/:rentalId/disk-wipe', auth, async (req, res) => {
  try {
    const wipe = await sessions.queueDiskWipe(req.params.rentalId, req.body?.method);
    res.status(201).json({ success: true, wipe });
  } catch (e) { handleError(e, res); }
});

router.use((error, req, res, next) => {
  if (error instanceof sessions.SessionUnavailable || error instanceof sessions.SessionError) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
  console.error('Session route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
});

module.exports = router;
