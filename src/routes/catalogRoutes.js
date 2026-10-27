/**
 * Catalog routes (Phase 2): purposes, software, access methods, availability.
 *
 * Mounted at /api BEFORE the listing router so `/listings/:id/availability`
 * is resolved here instead of falling into listingRoutes' GET /:id handler.
 */
const express = require('express');
const router = express.Router();

const catalog = require('../services/catalogService');
const { auth, providerAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

router.param('id', (req, res, next, id) => {
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid listing id' });
  next();
});

const fail = (res, error, fallbackMessage) => {
  if (error instanceof catalog.CatalogUnavailable) {
    return res.status(503).json({ message: error.message, code: error.code });
  }
  if (error instanceof catalog.CatalogError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  console.error(`${fallbackMessage}:`, error.message || String(error));
  return res.status(500).json({ message: fallbackMessage });
};

// @desc    The rental-purpose catalog (public)
// @route   GET /api/purposes
// @access  Public
router.get('/purposes', async (req, res) => {
  try {
    const purposes = await catalog.listPurposes();
    res.json({ success: true, purposes });
  } catch (error) {
    fail(res, error, 'Server error loading purposes');
  }
});

// @desc    Weekly schedule, blackouts and booked windows for one listing
// @route   GET /api/listings/:id/availability?hours=48
// @access  Public (availability is not sensitive: it is when the GPU is busy)
router.get('/listings/:id/availability', async (req, res) => {
  try {
    const availability = await catalog.describeAvailability(req.params.id, {
      hours: parseInt(req.query.hours, 10) || 48
    });
    res.json({ success: true, availability });
  } catch (error) {
    fail(res, error, 'Server error loading availability');
  }
});

// @desc    Replace the listing's purpose set (and per-purpose price/specs)
// @route   PUT /api/listings/:id/purposes
// @access  Private/Provider (owner only)
router.put('/listings/:id/purposes', auth, providerAuth, async (req, res) => {
  try {
    const result = await catalog.replacePurposes({
      listingId: req.params.id,
      providerId: req.user.id,
      purposes: req.body ? req.body.purposes : undefined
    });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error, 'Server error saving purposes');
  }
});

// @desc    Replace the installed-software list
// @route   PUT /api/listings/:id/software
// @access  Private/Provider (owner only)
router.put('/listings/:id/software', auth, providerAuth, async (req, res) => {
  try {
    const result = await catalog.replaceSoftware({
      listingId: req.params.id,
      providerId: req.user.id,
      software: req.body ? req.body.software : undefined
    });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error, 'Server error saving software');
  }
});

// @desc    Replace the access methods (ssh / rdp / streaming / jupyter)
// @route   PUT /api/listings/:id/access-methods
// @access  Private/Provider (owner only)
router.put('/listings/:id/access-methods', auth, providerAuth, async (req, res) => {
  try {
    const result = await catalog.setAccessMethods({
      listingId: req.params.id,
      providerId: req.user.id,
      methods: req.body ? req.body.methods : undefined
    });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error, 'Server error saving access methods');
  }
});

// @desc    Replace the recurring weekly availability windows
// @route   PUT /api/listings/:id/availability
// @access  Private/Provider (owner only)
router.put('/listings/:id/availability', auth, providerAuth, async (req, res) => {
  try {
    const result = await catalog.replaceAvailability({
      listingId: req.params.id,
      providerId: req.user.id,
      windows: req.body ? req.body.windows : undefined
    });
    res.json({ success: true, availability: { windows: result.windows, blackouts: result.blackouts } });
  } catch (error) {
    fail(res, error, 'Server error saving availability');
  }
});

// @desc    Close a one-off window (maintenance, travel, a private job)
// @route   POST /api/listings/:id/blackouts
// @access  Private/Provider (owner only)
router.post('/listings/:id/blackouts', auth, providerAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const blackout = await catalog.addBlackout({
      listingId: req.params.id,
      providerId: req.user.id,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      reason: body.reason
    });
    res.status(201).json({ success: true, blackout });
  } catch (error) {
    fail(res, error, 'Server error saving the blackout');
  }
});

// @desc    Reopen a blackout
// @route   DELETE /api/listings/:id/blackouts/:blackoutId
// @access  Private/Provider (owner only)
router.delete('/listings/:id/blackouts/:blackoutId', auth, providerAuth, async (req, res) => {
  try {
    if (!isUuid(req.params.blackoutId)) {
      return res.status(400).json({ message: 'Invalid blackout id' });
    }
    const removed = await catalog.removeBlackout({
      listingId: req.params.id,
      providerId: req.user.id,
      blackoutId: req.params.blackoutId
    });
    if (!removed) return res.status(404).json({ message: 'Blackout not found' });
    res.json({ success: true, message: 'Blackout removed' });
  } catch (error) {
    fail(res, error, 'Server error removing the blackout');
  }
});

module.exports = router;
