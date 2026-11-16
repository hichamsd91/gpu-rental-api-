// Phase 5 session routes — mounted at /api/sessions
const express = require('express');
const router = express.Router();
const sessions = require('../services/sessionService');
const { RentalService } = require('../services/supabaseService');
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

// A session belongs to exactly two people (its renter and its provider), plus
// admins. Without this gate any logged-in user could issue SSH keys into
// someone else's live GPU, queue a disk wipe, or read their heartbeats.
const ownsSession = async (req, res, next) => {
  try {
    const rental = await RentalService.findById(req.params.rentalId);
    if (!rental) return res.status(404).json({ success: false, code: 'not_found', message: 'Rental not found' });
    const uid = req.user && req.user.id;
    const isParty = uid && (rental.renterId === uid || rental.providerId === uid);
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isParty && !isAdmin) {
      return res.status(403).json({ success: false, code: 'forbidden', message: 'You are not part of this session' });
    }
    req.rental = rental;
    next();
  } catch (error) { next(error); }
};

router.post('/:rentalId/heartbeat', auth, ownsSession, async (req, res) => {
  try {
    const hb = await sessions.recordHeartbeat(req.params.rentalId, req.body || {});
    res.json({ success: true, heartbeat: hb });
  } catch (e) { handleError(e, res); }
});

router.get('/:rentalId/heartbeat/latest', auth, ownsSession, async (req, res) => {
  try {
    const hb = await sessions.latestHeartbeat(req.params.rentalId);
    res.json({ success: true, heartbeat: hb });
  } catch (e) { handleError(e, res); }
});

router.post('/:rentalId/events', auth, ownsSession, async (req, res) => {
  try {
    const ev = await sessions.recordEvent(req.params.rentalId, req.body?.eventType || 'started', req.body?.payload || {});
    res.status(201).json({ success: true, event: ev });
  } catch (e) { handleError(e, res); }
});

router.get('/:rentalId/ssh-keys', auth, ownsSession, async (req, res) => {
  try {
    const keys = await sessions.activeSshKeys(req.params.rentalId);
    res.json({ success: true, keys });
  } catch (e) { handleError(e, res); }
});

router.post('/:rentalId/ssh-keys', auth, ownsSession, async (req, res) => {
  try {
    const key = await sessions.issueSshKey(req.params.rentalId, req.body?.publicKey, req.body?.expiresAt);
    res.status(201).json({ success: true, key });
  } catch (e) { handleError(e, res); }
});

router.delete('/:rentalId/ssh-keys', auth, ownsSession, async (req, res) => {
  try {
    const revoked = await sessions.revokeSshKeys(req.params.rentalId, req.body?.reason);
    res.json({ success: true, revoked });
  } catch (e) { handleError(e, res); }
});

router.post('/:rentalId/disk-wipe', auth, ownsSession, async (req, res) => {
  try {
    const wipe = await sessions.queueDiskWipe(req.params.rentalId, req.body?.method);
    res.status(201).json({ success: true, wipe });
  } catch (e) { handleError(e, res); }
});

// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
  if (error instanceof sessions.SessionUnavailable || error instanceof sessions.SessionError) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
  console.error('Session route error:', error);
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
});

module.exports = router;
