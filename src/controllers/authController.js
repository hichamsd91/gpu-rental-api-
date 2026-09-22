const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendTokenResponse } = require('../utils/token');
const { validateRequest } = require('../middleware/validation');
const { body } = require('express-validator');

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
exports.register = [
  validateRequest([
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('role').optional().isIn(['provider', 'renter']).withMessage('Invalid role')
  ]),
  async (req, res) => {
    try {
      const { email, password, fullName, role = 'renter' } = req.body;

      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: 'User already exists with this email' });
      }

      const user = await User.create({
        email,
        password,
        fullName,
        role
      });

      sendTokenResponse(user, 201, res);
    } catch (error) {
      console.error('Register error:', error);
      res.status(500).json({ message: 'Server error during registration' });
    }
  }
];

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = [
  validateRequest([
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required')
  ]),
  async (req, res) => {
    try {
      const { email, password } = req.body;

      const user = await User.findOne({ email }).select('+password');
      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      if (!user.isActive) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }

      user.lastLoginAt = new Date();
      await user.save();

      sendTokenResponse(user, 200, res);
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ message: 'Server error during login' });
    }
  }
];

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isVerified: user.isVerified,
        phoneNumber: user.phoneNumber,
        bio: user.bio,
        avatarUrl: user.avatarUrl
      }
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Refresh token
// @route   POST /api/auth/refresh
// @access  Public
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: 'Refresh token is required' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    sendTokenResponse(user, 200, res);
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({ message: 'Invalid refresh token' });
  }
};
