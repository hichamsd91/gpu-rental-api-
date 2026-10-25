const express = require('express');
const router = express.Router();
const { GpuListingService } = require('../services/supabaseService');
const { auth, providerAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

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
      page = 1,
      limit = 20,
      search = '',
      brand = '',
      minVram = '',
      maxPrice = '',
      sortBy = 'price_asc'
    } = req.query;

    const result = await GpuListingService.findAll({
      status: 'active',
      isPublic: true,
      search,
      gpuBrand: brand,
      minVram,
      maxPrice
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
    const listing = await GpuListingService.create(req.body, req.user.id);
    res.status(201).json({ success: true, listing });
  } catch (error) {
    console.error('Create listing error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Update listing
// @route   PUT /api/listings/:id
// @access  Private/Provider
router.put('/:id', auth, providerAuth, async (req, res) => {
  try {
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