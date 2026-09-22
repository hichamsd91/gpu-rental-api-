const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { UserService } = require('../services/supabaseService');
const { sendTokenResponse } = require('../utils/token');
const { validateRequest } = require('../middleware/validation');
const { body } = require('express-validator');

const normalizeEmail = email => String(email || '').trim().toLowerCase();

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
router.post('/register', validateRequest([
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('fullName').notEmpty().withMessage('Full name is required'),
  body('role').optional().isIn(['provider', 'renter', 'admin']).withMessage('Invalid role')
]), async (req, res) => {
  try {
    const { email, password, fullName, role = 'renter' } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const existingUser = await UserService.findByEmail(normalizedEmail);
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    const user = await UserService.create({ email: normalizedEmail, password, fullName, role });
    sendTokenResponse(user, 201, res);
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Server error during registration' });
  }
});

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
router.post('/login', validateRequest([
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
]), async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const user = await UserService.findByEmail(normalizedEmail);
    if (!user || !(await UserService.comparePassword(user, password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    await UserService.updateLastLogin(user.id);
    sendTokenResponse(user, 200, res);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
router.get('/me', require('../middleware/auth').auth, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user._id || user.id,
        email: user.email,
        fullName: user.fullName || user.full_name || user.name,
        role: user.role,
        isVerified: user.isVerified ?? user.is_verified ?? false,
        phoneNumber: user.phoneNumber || user.phone_number,
        bio: user.bio,
        avatarUrl: user.avatarUrl || user.avatar_url
      }
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/auth/logout
// @access  Private
router.post('/logout', require('../middleware/auth').auth, (req, res) => {
  res.json({ success: true, message: 'Logged out' });
});

// @desc    Refresh token
// @route   POST /api/auth/refresh
// @access  Public
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: 'Refresh token is required' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await UserService.findById(decoded.id);

    if (!user || user.isActive === false) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    sendTokenResponse(user, 200, res);
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({ message: 'Invalid refresh token' });
  }
});

module.exports = router;