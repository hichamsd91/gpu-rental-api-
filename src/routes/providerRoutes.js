const express = require('express');
const router = express.Router();
const { GpuListingService } = require('../services/supabaseService');
const { providerAuth } = require('../middleware/auth');

// Provider self-service endpoints. This file is mounted at /api/provider — it never
// touches the public /api/listings tree, so there is no route overlap with
// listingRoutes' GET /:id catch-all by construction.

// @desc    Get the calling provider's OWN listings — every status included
//          (active/paused/maintenance/private), unlike the public endpoint which
//          only lists active+public rows. The row-level scope below is the ONLY
//          filter applied; pagination metadata lives under `pagination`.
// @route   GET /api/provider/listings?page=&limit=
// @access  Private/Provider (provider or admin roles)
router.get('/listings', providerAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

    // Scope to the authenticated identity only. An admin who is not also a
    // provider simply gets an empty set — no cross-tenant reads (fail closed).
    // includeAccess: this caller lists THEIR OWN rows above, so their own remote
    // access config round-trips into the edit form (public endpoints scrub it).
    const result = await GpuListingService.findAll(
      { providerId: req.user.id },
      { page, limit, includeAccess: true }
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Provider listings error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
