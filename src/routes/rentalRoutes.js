const express = require('express');
const router = express.Router();
const { RentalService, GpuListingService } = require('../services/supabaseService');
const { auth } = require('../middleware/auth');
const { PlatformCommissionService } = require('../services/commissionService');

const idsEqual = (left, right) => left && right && left.toString() === right.toString();

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

// @desc    Create rental
// @route   POST /api/rentals
// @access  Private/Renter
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'renter') {
      return res.status(403).json({ message: 'Only renters can create rentals' });
    }

    const { listingId, plannedDurationMinutes } = req.body;

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

    const estimatedCost = (plannedDurationMinutes / 60) * listing.pricePerHour;
    if (!Number.isFinite(estimatedCost) || estimatedCost < 0) {
      return res.status(400).json({ message: 'Listing has an invalid price' });
    }

    const rental = await RentalService.create({
      listingId,
      providerId: listing.providerId,
      plannedDurationMinutes,
      estimatedCost
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
    if (isValidationError(error)) {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    End rental
// @route   POST /api/rentals/:id/end
// @access  Private
router.post('/:id/end', auth, async (req, res) => {
  try {
    const endedRental = await RentalService.endRental(req.params.id, req.user.id, req.user.role);
    res.json({ success: true, rental: endedRental });
  } catch (error) {
    console.error('End rental error:', error);
    if (isValidationError(error)) {
      return res.status(400).json({ message: error.message });
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
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;