const express = require('express');
const router = express.Router();
const { WaitlistService, isMissingSchemaObject } = require('../services/supabaseService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ALLOWED_ROLES = ['provider', 'renter', 'both'];

// @desc    Join the "phone fleet" coming-soon waitlist (public)
// @route   POST /api/waitlist
// @access  Public
router.post('/', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = ALLOWED_ROLES.includes(req.body?.role) ? req.body.role : 'provider';

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }

    const result = await WaitlistService.add(email, role);
    // Idempotent: joining twice is a success, not an error
    res.status(result.alreadyJoined ? 200 : 201).json({
      success: true,
      alreadyJoined: result.alreadyJoined === true
    });
  } catch (error) {
    // The additive waitlist migration has not run yet (schema-cache error).
    if (isMissingSchemaObject(error)) {
      return res
        .status(503)
        .json({ success: false, message: 'Waitlist is temporarily unavailable' });
    }
    console.error('Waitlist error:', error.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
