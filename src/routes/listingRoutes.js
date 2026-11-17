const express = require('express');
const router = express.Router();
const { GpuListingService, DeviceService } = require('../services/supabaseService');
const { auth, providerAuth } = require('../middleware/auth');
const { isUuid, parsePagedQuery } = require('../middleware/validation');

// Every route below addresses a listing by uuid. Reject malformed ids here so
// PostgREST never sees them (an invalid uuid used to surface as a 500).
router.param('id', (req, res, next, id) => {
  if (!isUuid(id)) {
    return res.status(400).json({ message: 'Invalid listing id' });
  }
  next();
});

// @desc    Get all public listings
// @route   GET /api/listings
// @access  Public
router.get('/', async (req, res) => {
  try {
    const {
      search = '',
      brand = '',
      minVram = '',
      maxPrice = '',
      purpose = '',
      sortBy = 'price_asc'
    } = req.query;
    // Never let `?limit=100000` turn the catalog into a bulk export.
    const { page, limit } = parsePagedQuery(req.query);

    const result = await GpuListingService.findAll({
      status: 'active',
      isPublic: true,
      search,
      gpuBrand: brand,
      minVram,
      maxPrice,
      purpose
    }, { page, limit, sortBy });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Get listings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get single listing
// @route   GET /api/listings/:id
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    // Public detail must mirror the public list: only active, publicly listed
    // rows. A hidden/paused listing is 404 here even if its uuid is known.
    const listing = await GpuListingService.findById(req.params.id, null, { publicOnly: true });

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    res.json({ success: true, listing });
  } catch (error) {
    console.error('Get listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Create listing (provider only)
// @route   POST /api/listings
// @access  Private/Provider
router.post('/', auth, providerAuth, async (req, res) => {
  try {
    // A listing always belongs to a registered device: the column is NOT NULL.
    // Validate before the insert so the caller gets a 400 with a reason instead
    // of a generic 500 from the database.
    const body = req.body || {};
    if (!isUuid(body.deviceId)) {
      return res.status(400).json({ message: 'deviceId is required and must be a valid device id' });
    }
    // …and it must be YOUR device. Otherwise a provider can list hardware they
    // do not own (or re-point someone else's listing at their machine).
    const owned = await DeviceService.findById(body.deviceId).catch(() => null);
    if (!owned || owned.userId !== req.user.id) {
      return res.status(403).json({ success: false, code: 'device_not_owned', message: 'That device does not belong to you' });
    }
    if (body.gpuId !== undefined && body.gpuId !== null && body.gpuId !== '' && !isUuid(body.gpuId)) {
      return res.status(400).json({ message: 'gpuId must be a valid GPU id' });
    }
    // Number(null) and Number('') are 0, so test the raw value first: a listing
    // must carry an explicit price, even when that price is zero.
    const rawPrice = body.pricePerHour;
    const price = Number(rawPrice);
    if (rawPrice === undefined || rawPrice === null || rawPrice === ''
      || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ message: 'pricePerHour must be a non-negative number' });
    }

    const listing = await GpuListingService.create(body, req.user.id);
    res.status(201).json({ success: true, listing });
  } catch (error) {
    console.error('Create listing error:', error);
    // Constraint violations are bad input, not a server fault.
    if (['23502', '23514', '22P02'].includes(error && error.code)) {
      return res.status(400).json({ message: 'Invalid listing data' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Update listing
// @route   PUT /api/listings/:id
// @access  Private/Provider
router.put('/:id', auth, providerAuth, async (req, res) => {
  try {
    // Re-pointing a listing at a device is only allowed for your own hardware.
    if (req.body && req.body.deviceId !== undefined) {
      const owned = await DeviceService.findById(req.body.deviceId).catch(() => null);
      if (!owned || owned.userId !== req.user.id) {
        return res.status(403).json({ success: false, code: 'device_not_owned', message: 'That device does not belong to you' });
      }
    }
    const listing = await GpuListingService.update(req.params.id, req.body, req.user.id);

    if (!listing) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    res.json({ success: true, listing });
  } catch (error) {
    console.error('Update listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Delete listing
// @route   DELETE /api/listings/:id
// @access  Private/Provider
router.delete('/:id', auth, providerAuth, async (req, res) => {
  try {
    // delete() now reports whether a row actually matched this provider. A
    // cross-tenant / stale id must not answer "success" while deleting nothing.
    const deleted = await GpuListingService.delete(req.params.id, req.user.id);

    if (!deleted) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    res.json({ success: true, message: 'Listing deleted' });
  } catch (error) {
    console.error('Delete listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
