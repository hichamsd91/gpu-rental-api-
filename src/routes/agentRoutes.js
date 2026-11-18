/**
 * Worker-agent endpoints.
 *
 * A provider's machine (the worker agent) is the only caller here. It proves
 * which provider it is with the normal JWT, and which machine it is with a
 * device id that must belong to that provider AND to the rental's listing.
 *
 * Everything the agent sends is untrusted telemetry/log text: it is bounded and
 * stored, never executed.
 */
const express = require('express');
const router = express.Router();

const { auth, providerAuth } = require('../middleware/auth');
const { isUuid } = require('../middleware/validation');
const { DeviceService, GpuListingService, RentalService } = require('../services/supabaseService');
const jobs = require('../services/jobService');

router.param('rentalId', (req, res, next, rentalId) => {
  if (!isUuid(rentalId)) return res.status(400).json({ success: false, code: 'invalid_id', message: 'Invalid rental id' });
  next();
});

const fail = (res, error) => {
  if (error instanceof jobs.JobError) {
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.error('[agent]', error.message || String(error));
  return res.status(500).json({ success: false, code: 'server_error', message: 'Server error' });
};

/** The rental, only when it belongs to this provider and runs on this device. */
const ownedRentalOnDevice = async (req, rentalId, deviceId) => {
  if (!isUuid(deviceId)) {
    throw new jobs.JobError('deviceId is required', 'device_required');
  }
  const device = await DeviceService.findById(deviceId).catch(() => null);
  if (!device || String(device.userId) !== String(req.user.id)) {
    throw new jobs.JobError('That device does not belong to you', 'device_not_owned', 403);
  }
  const rental = await RentalService.findById(rentalId);
  if (!rental) throw new jobs.JobError('Rental not found', 'not_found', 404);
  if (String(rental.providerId) !== String(req.user.id)) {
    throw new jobs.JobError('This session is not yours', 'forbidden', 403);
  }
  const listing = await GpuListingService.findById(rental.listingId);
  if (!listing || String(listing.deviceId) !== String(deviceId)) {
    throw new jobs.JobError('This session does not run on that device', 'device_mismatch', 403);
  }
  return { rental, listing, device };
};

// @desc    Agent heartbeat: telemetry + the queued work for this machine
// @route   POST /api/agent/heartbeat
// @access  Private/Provider
router.post('/heartbeat', auth, providerAuth, async (req, res) => {
  try {
    const { deviceId, stats } = req.body || {};
    if (!isUuid(deviceId)) {
      throw new jobs.JobError('deviceId is required', 'device_required');
    }
    const device = await DeviceService.findById(deviceId).catch(() => null);
    if (!device || String(device.userId) !== String(req.user.id)) {
      throw new jobs.JobError('That device does not belong to you', 'device_not_owned', 403);
    }
    await DeviceService.updateHeartbeat(deviceId, stats || {});
    const pending = await jobs.pendingForDevice({ providerId: req.user.id, deviceId });
    res.json({ success: true, serverTime: new Date().toISOString(), jobs: pending });
  } catch (error) {
    fail(res, error);
  }
});

// @desc    Claim a queued job (atomic; null when another agent won the race)
// @route   POST /api/agent/jobs/:rentalId/claim
// @access  Private/Provider
router.post('/jobs/:rentalId/claim', auth, providerAuth, async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    const { rental } = await ownedRentalOnDevice(req, req.params.rentalId, deviceId);
    const job = await jobs.findByRental(rental.id);
    if (!job) return res.status(404).json({ success: false, code: 'not_found', message: 'No job for this session' });

    const claimed = await jobs.claim({ rental, job, deviceId });
    if (!claimed) {
      return res.status(409).json({
        success: false,
        code: 'job_not_claimable',
        message: rental.status === 'active' ? 'Another agent claimed this job' : 'The session is not running'
      });
    }
    res.json({ success: true, job: claimed });
  } catch (error) {
    fail(res, error);
  }
});

// @desc    Progress line (+ optional telemetry). Answers the current status so
//          an agent can stop work whose session ended under it.
// @route   POST /api/agent/jobs/:rentalId/progress
// @access  Private/Provider
router.post('/jobs/:rentalId/progress', auth, providerAuth, async (req, res) => {
  try {
    const { deviceId, message, percent, telemetry } = req.body || {};
    await ownedRentalOnDevice(req, req.params.rentalId, deviceId);
    const result = await jobs.progress({ rentalId: req.params.rentalId, message, percent, telemetry });
    res.json({ success: true, ...result });
  } catch (error) {
    fail(res, error);
  }
});

// @desc    Final report for a job
// @route   POST /api/agent/jobs/:rentalId/complete
// @access  Private/Provider
router.post('/jobs/:rentalId/complete', auth, providerAuth, async (req, res) => {
  try {
    const { deviceId, status, exitCode, result, log } = req.body || {};
    await ownedRentalOnDevice(req, req.params.rentalId, deviceId);
    const job = await jobs.complete({ rentalId: req.params.rentalId, status, exitCode, result, log });
    res.json({ success: true, job });
  } catch (error) {
    fail(res, error);
  }
});

module.exports = router;
