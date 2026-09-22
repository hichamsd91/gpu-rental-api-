const express = require('express');
const router = express.Router();

// @desc    Get signaling info for P2P
// @route   GET /api/signaling/info
// @access  Public
router.get('/info', (req, res) => {
  res.json({
    success: true,
    signaling: {
      url: process.env.SIGNALING_URL || 'http://localhost:5000',
      stunServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });
});

module.exports = router;
