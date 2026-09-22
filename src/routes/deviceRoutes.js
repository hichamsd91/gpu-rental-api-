const express = require('express');
const router = express.Router();
const { DeviceService } = require('../services/supabaseService');
const { auth, providerAuth } = require('../middleware/auth');

// @desc    Register device
// @route   POST /api/devices/register
// @access  Private/Provider
router.post('/register', auth, providerAuth, async (req, res) => {
  try {
    const device = await DeviceService.create({
      ...req.body,
      userId: req.user.id
    });

    res.status(201).json({ success: true, device });
  } catch (error) {
    console.error('Register device error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Send heartbeat
// @route   POST /api/devices/heartbeat
// @access  Private/Provider
router.post('/heartbeat', auth, providerAuth, async (req, res) => {
  try {
    const { deviceId, stats } = req.body;

    const device = await DeviceService.findById(deviceId);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }

    if (device.userId !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const updatedDevice = await DeviceService.updateHeartbeat(deviceId, stats);
    res.json({ success: true, device: updatedDevice });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get provider devices
// @route   GET /api/devices
// @access  Private/Provider
router.get('/', auth, providerAuth, async (req, res) => {
  try {
    const devices = await DeviceService.findByUserId(req.user.id);
    res.json({ success: true, devices });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Update device
// @route   PUT /api/devices/:id
// @access  Private/Provider
router.put('/:id', auth, providerAuth, async (req, res) => {
  try {
    const device = await DeviceService.update(req.params.id, req.body, req.user.id);

    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }

    res.json({ success: true, device });
  } catch (error) {
    console.error('Update device error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;