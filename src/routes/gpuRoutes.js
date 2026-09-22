const express = require('express');
const router = express.Router();
const { GpuService } = require('../services/supabaseService');
const { auth, adminAuth } = require('../middleware/auth');

// @desc    Get all GPUs
// @route   GET /api/gpus
// @access  Public
router.get('/', async (req, res) => {
  try {
    const { brand, isActive = true } = req.query;
    const gpus = await GpuService.findAll({ isActive: isActive === 'true' });

    if (brand) {
      const filtered = gpus.filter(g => g.brand === brand);
      return res.json({ success: true, gpus: filtered });
    }

    res.json({ success: true, gpus });
  } catch (error) {
    console.error('Get GPUs error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Get single GPU
// @route   GET /api/gpus/:id
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const gpu = await GpuService.findById(req.params.id);

    if (!gpu) {
      return res.status(404).json({ message: 'GPU not found' });
    }

    res.json({ success: true, gpu });
  } catch (error) {
    console.error('Get GPU error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @desc    Create GPU (admin only)
// @route   POST /api/gpus
// @access  Private/Admin
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const gpu = await GpuService.create(req.body);
    res.status(201).json({ success: true, gpu });
  } catch (error) {
    console.error('Create GPU error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;