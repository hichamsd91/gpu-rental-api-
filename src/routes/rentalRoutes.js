const express = require('express');
const router = express.Router();
const { RentalService, GpuListingService } = require('../services/supabaseService');
const catalog = require('../services/catalogService');
const featureFlags = require('../services/featureFlagService');
const { usdToTokens } = require('../utils/pricing');
const { auth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');

// Every :id route below is a rental uuid. Without this guard "undefined" or any
// other string reached PostgREST and surfaced as a 500.
router.param('id', (req, res, next, id) => {
  if (!isUuid(id)) {
    return res.status(400).json({ message: 'Invalid rental id' });
  }
  next();
});

const idsEqual = (left, right) => left && right && left.toString() === right.toString();

// Service-layer refusals must not look like server faults: answering 500 for
// "not your rental" hides real incidents and gives the client nothing to show.
const forbidden = (error) => Boolean(error && (error.status === 403 || /not authorized|not allowed/i.test(String(error.message || ''))));

const canStartRental = (req, rental) => (
  req.user.role === 'admin' ||
  (req.user.role === 'renter' && idsEqual(rental.renterId, req.user.id))
);

const canManageRental = (req, rental) => (
  req.user.role === 'admin' ||
  (req.user.role === 'renter' && idsEqual(rental.renterId, req.user.id)) ||
  (req.user.role === 'provider' && idsEqual(rental.providerId, req.user.id))
);

const validatePlannedDuration = (plannedDurationMinutes, listing) => {
  if (!Number.isInteger(plannedDurationMinutes) || plannedDurationMinutes < 1) {
    return 'plannedDurationMinutes must be a positive whole number';
  }

  const minMinutes = Number(listing.minRentalMinutes);
  const maxMinutes = Number(listing.maxRentalHours) * 60;
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes) || minMinutes < 1 || maxMinutes < minMinutes) {
    return 'Listing has invalid rental duration bounds';
  }
  if (plannedDurationMinutes < minMinutes) {
    return `Rental duration must be at least ${minMinutes} minutes`;
  }
  if (plannedDurationMinutes > maxMinutes) {
    return `Rental duration cannot exceed ${maxMinutes} minutes`;
  }
  return null;
};

/**
 * Picks the purpose the renter asked for (or the listing's first purpose) and
 * the price that actually applies to it.
 *
 * A purpose with an explicit price is a separate product — mining must never
 * silently bill at the base rate. When the listing offers no purposes at all
 * (legacy rows, or migration 012 not applied) the base price is used.
 */
const resolvePurpose = (listing, requestedPurpose) => {
  const purposes = Array.isArray(listing.purposes) ? listing.purposes : [];
  const requested = requestedPurpose === undefined || requestedPurpose === null
    ? ''
    : String(requestedPurpose).trim();

  if (!requested) {
    const first = purposes[0];
    if (!first) return { purpose: null, pricePerHour: Number(listing.pricePerHour), purposeRow: null };
    return {
      purpose: first.key,
      pricePerHour: first.pricePerHour === null || first.pricePerHour === undefined
        ? Number(listing.pricePerHour)
        : Number(first.pricePerHour),
      purposeRow: first
    };
  }

  const match = purposes.find((p) => p.key === requested);
  if (!match) {
    return { error: `This listing is not offered for "${requested}"`, code: 'purpose_not_offered' };
  }
  return {
    purpose: match.key,
    pricePerHour: match.pricePerHour === null || match.pricePerHour === undefined
      ? Number(listing.pricePerHour)
      : Number(match.pricePerHour),
    purposeRow: match
  };
};

const isValidationError = error => error && (
  error.name === 'ValidationError' ||
  error.name === 'CastError'
);

// @desc    Get user rentals
// @route   GET /api/rentals
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const result = await RentalService.findAll(req.user.id, req.user.role, { status }, { page, limit });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Get rentals error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get a single rental — owner-scoped (renter's own / provider's own / admin)
// @route   GET /api/rentals/:id
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const rental = await RentalService.findById(req.params.id);

    if (!rental) {
      return res.status(404).json({ message: 'Rental not found' });
    }

    // Same authorization matrix as end/cancel — findById itself is unscoped, so the
    // scope check MUST live here (a leaked rental id is never readable by a stranger).
    if (!canManageRental(req, rental)) {
      return res.status(403).json({ message: 'Not authorized to view this rental' });
    }

    res.json({ success: true, rental });
  } catch (error) {
    console.error('Get rental error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Create rental
// @route   POST /api/rentals
// @access  Private/Renter
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'renter') {
      return res.status(403).json({ message: 'Only renters can create rentals' });
    }

    const { listingId, plannedDurationMinutes, billingMode, purpose, miningAcknowledged } = req.body;

    const listing = await GpuListingService.findById(listingId);
    if (!listing) {
      return res.status(404).json({ message: 'Listing not found' });
    }

    if (listing.status !== 'active') {
      return res.status(400).json({ message: 'Listing is not available' });
    }

    const durationError = validatePlannedDuration(plannedDurationMinutes, listing);
    if (durationError) {
      return res.status(400).json({ message: durationError });
    }

    // --- Purpose + its price (P2-02 / P2-06) -----------------------------
    const quote = resolvePurpose(listing, purpose);
    if (quote.error) {
      return res.status(400).json({ message: quote.error, code: quote.code });
    }

    if (quote.purpose === 'mining') {
      // D2 is opt-in on BOTH sides: the platform flag must be on and the renter
      // must acknowledge the declared power/disclosure before a hashing window.
      const miningEnabled = await featureFlags.isEnabled('mining.allowed');
      if (!miningEnabled) {
        return res.status(403).json({
          message: 'Mining rentals are disabled on this deployment',
          code: 'mining_disabled'
        });
      }
      if (miningAcknowledged !== true) {
        return res.status(400).json({
          message: 'Mining requires an explicit acknowledgement of the declared power cap and disclosure',
          code: 'mining_ack_required'
        });
      }
    }

    // --- Availability + conflict prevention (P2-04) ----------------------
    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + plannedDurationMinutes * 60000);
    const { windows, blackouts } = await catalog.getAvailabilityRows(listingId);
    if (!catalog.isWindowOpen(windows, blackouts, windowStart, windowEnd)) {
      return res.status(409).json({
        message: 'This machine is not available for the requested window',
        code: 'listing_closed',
        nextOpeningAt: catalog.findNextOpening(windows, blackouts, windowStart)
      });
    }
    const conflicts = await catalog.findConflicts({ listingId, start: windowStart, end: windowEnd });
    if (conflicts.length) {
      return res.status(409).json({
        message: 'This machine is already reserved for the requested window',
        code: 'listing_busy',
        busyUntil: conflicts
          .map((row) => row.end_time || row.start_time)
          .sort()
          .pop() || null
      });
    }

    const estimatedCost = (plannedDurationMinutes / 60) * quote.pricePerHour;
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
      return res.status(400).json({ message: 'Listing has an invalid price' });
    }

    const normalizedBillingMode = ['time', 'tokens'].includes(billingMode)
      ? billingMode
      : 'time';

    const rental = await RentalService.create({
      listingId,
      providerId: listing.providerId,
      purpose: quote.purpose,
      plannedDurationMinutes,
      estimatedCost,
      estimatedCostTokens: usdToTokens(estimatedCost),
      billingMode: normalizedBillingMode
    }, req.user.id);

    res.status(201).json({ success: true, rental });
  } catch (error) {
    console.error('Create rental error:', error);
    if (isValidationError(error)) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Free ad-supported rentals — retired
// @route   POST /api/rentals/free
// @access  Private/Renter
// The 2-hour free tier was removed by owner decision: it shifted the cost onto
// the provider (who donated two hours of hardware) and made hosts leave.
router.post('/free', auth, (req, res) => {
  res.status(410).json({
    success: false,
    code: 'free_sessions_retired',
    message: 'Free ad-supported sessions have been retired. Book a paid session instead.'
  });
});

// @desc    Start rental
// @route   POST /api/rentals/:id/start
// @access  Private
router.post('/:id/start', auth, async (req, res) => {
  try {
    const rental = await RentalService.findById(req.params.id);

    if (!rental) {
      return res.status(404).json({ message: 'Rental not found' });
    }

    if (!canStartRental(req, rental)) {
      return res.status(403).json({ message: 'Not authorized to start this rental' });
    }

    if (rental.status !== 'pending') {
      return res.status(400).json({ message: 'Rental cannot be started' });
    }

    const startedRental = await RentalService.startRental(req.params.id, req.user.id);
    res.json({ success: true, rental: startedRental });
  } catch (error) {
    console.error('Start rental error:', error);
    // Wallet gate: no state has changed — a clear payment-required signal the
    // client maps to its localized "top up your wallet" flow.
    if (error && error.code === 'WALLET_INSUFFICIENT') {
      const body = { success: false, code: 'WALLET_INSUFFICIENT', message: error.message };
      // Numbers let the client render a localized "need X / have Y" template.
      if (Number.isFinite(error.required)) body.required = Number(error.required);
      if (Number.isFinite(error.available)) body.available = Number(error.available);
      return res.status(402).json(body);
    }
    if (isValidationError(error)) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Allowed provider-side reasons to end a running session. A provider can never
// end a session as "completed" — they are the supplier, not the buyer.
const PROVIDER_END_REASONS = new Set(['maintenance', 'hardware_failure', 'emergency']);

// @desc    End rental
// @route   POST /api/rentals/:id/end
// @access  Private
router.post('/:id/end', auth, async (req, res) => {
  try {
    const isProviderOnly = req.user.role === 'provider';
    const rawReason = req.body && req.body.reason ? String(req.body.reason).trim() : '';

    let endReason;
    if (isProviderOnly) {
      if (!PROVIDER_END_REASONS.has(rawReason)) {
        return res.status(400).json({
          success: false,
          code: 'provider_reason_required',
          message: 'A provider must end a session with a reason: maintenance, hardware_failure or emergency.',
          allowed: [...PROVIDER_END_REASONS]
        });
      }
      endReason = `provider_ended:${rawReason}`;
    } else {
      endReason = req.user.role === 'admin' ? 'admin_ended' : 'renter_ended';
    }

    const endedRental = await RentalService.endRental(
      req.params.id,
      req.user.id,
      req.user.role,
      endReason
    );
    res.json({ success: true, rental: endedRental });
  } catch (error) {
    console.error('End rental error:', error);
    if (isValidationError(error)) {
      return res.status(400).json({ message: error.message });
    }
    if (forbidden(error)) {
      return res.status(403).json({ success: false, code: 'forbidden', message: 'You are not allowed to end this rental' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Cancel rental
// @route   POST /api/rentals/:id/cancel
// @access  Private
router.post('/:id/cancel', auth, async (req, res) => {
  try {
    const cancelledRental = await RentalService.cancelRental(req.params.id, req.user.id, req.user.role);
    res.json({ success: true, rental: cancelledRental });
  } catch (error) {
    console.error('Cancel rental error:', error);
    if (isValidationError(error)) {
      return res.status(400).json({ message: error.message });
    }
    if (forbidden(error)) {
      return res.status(403).json({ success: false, code: 'forbidden', message: 'You are not allowed to cancel this rental' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
