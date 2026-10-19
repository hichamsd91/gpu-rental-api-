const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { UserService } = require('../services/supabaseService');
const { generateTokens, sendTokenResponse } = require('../utils/token');
const { validateRequest } = require('../middleware/validation');
const { body } = require('express-validator');

const normalizeEmail = email => String(email || '').trim().toLowerCase();

// Refresh-token revocation now lives in services/revocation.js — it is consulted here (refresh + logout)
// AND by middleware/auth.js on every protected request. Authenticity of any presented refresh token is
// always established with a real signature check below; `ignoreExpiration` still requires the correct HS256
// secret, so a forged token cannot forge jti/userId pairs into the blacklist.
const { isJtiBlacklisted, revokeJti } = require('../services/revocation');

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
router.post('/register', validateRequest([
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('fullName').notEmpty().withMessage('Full name is required'),
  // SECURITY: never allow self-registration as admin — admin accounts are provisioned only by operators
  body('role').optional().isIn(['provider', 'renter']).withMessage('Invalid role')
]), async (req, res) => {
  try {
    const { email, password, fullName, role = 'renter' } = req.body;
    const normalizedEmail = normalizeEmail(email);

    const existingUser = await UserService.findByEmail(normalizedEmail);
    if (existingUser) {
      // A deactivated account must not silently resurrect via re-registration.
      return res.status(existingUser.isActive === false ? 403 : 400).json({
        message: existingUser.isActive === false ? 'Account is deactivated. Contact support.' : 'User already exists with this email'
      });
    }

    const createdUser = await UserService.create({ email: normalizedEmail, password, fullName, role });
    sendTokenResponse(createdUser, 201, res);
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

// @desc    Revoke the presented refresh token and end the session server-side.
// Public on purpose: a logging-out client should be able to revoke even if its
// access token already expired; authenticity comes from the refresh signature.
// Best-effort contract — clients ignore failures (see Flutter ApiService.logout).
// @route   POST /api/auth/logout
// @access  Public (refresh-token verified internally)
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};

    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(401).json({ message: 'Refresh token is required' });
    }

    // Expired tokens still verify under ignoreExpiration as long as the secret
    // and algorithm match — enough to prove ownership for revocation.
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'], ignoreExpiration: true });
    } catch {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    if (!decoded.jti) {
      // Tokens issued before jti support exists cannot be revoked individually.
      console.warn('Logout for a pre-jti token; no revocation possible.');
      return res.json({ success: true, revoked: false, message: 'Logged out' });
    }

    const persisted = await revokeJti(decoded.jti, { userId: decoded.id, expSeconds: decoded.exp });

    if (persisted) {
      console.log(`Logout: refresh token ${decoded.jti} for user ${decoded.id} revoked.`);
      return res.json({ success: true, revoked: true, message: 'Session ended' });
    }
    // Table missing or DB down — the client's local sign-out must still succeed.
    console.error('Logout revocation could not be persisted (run migrations/004_auth_refresh_blacklist.sql).');
    return res.json({ success: true, revoked: false, message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    // Contract: never fail the client's logout because of a server-side hiccup.
    res.json({ success: true, revoked: false, message: 'Logged out' });
  }
});

// @desc    Refresh token (reissues an access+refresh pair; rotates jti)
// @route   POST /api/auth/refresh
// @access  Public
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: 'Refresh token is required' });
    }

    // Pin the algorithm: only HS256 (what generateTokens signs) is accepted.
    // Also enforces real expiry — a revoked-but-valid signature is rejected below.
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });

    if (!decoded.id) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    // Revoked tokens die here even though their signature + expiry are still valid.
    const revoked = await isJtiBlacklisted(decoded.jti);
    if (revoked === true) {
      console.warn(`Rejected REVOKED refresh token ${decoded.jti} for user ${decoded.id}.`);
      return res.status(401).json({ message: 'Refresh token has been revoked' });
    }

    let user;
    try {
      user = await UserService.findById(decoded.id); // a THROW here means the read failed — classified as infrastructure below; a genuinely MISSING row resolves null and takes the real-401 path after this block. That distinction is what keeps an outage from masquerading as "signed out".
    } catch (error) {
      console.error('Refresh user lookup failed:', error.message || String(error));
      return res.status(503).json({ message: 'Refresh is temporarily unavailable, retry shortly' });
    }

    if (!user || user.isActive === false) {
      return res.status(401).json({ message: 'Invalid refresh token' }); // no row ever / account deactivated — a genuine rejection, not an outage artifact
    }

    // Rotation with revocation: issue the NEW pair first (pure crypto — never blocked by a database hiccup),
    // then revoke the OLD jti last. If that write fails we still answer with fresh tokens but log loudly;
    // worst case is a bounded duplication window where both pairs verify, which is no worse than pre-rotation
    // behaviour and leaves an audit line — never does the old pair silently survive an unlogged rotation.
    const previousJti = decoded.jti;
    let tokens;
    try {
      tokens = await generateTokens(user._id || user.id);
    } catch (error) {
      console.error('Token generation error during refresh:', error.message);
      return res.status(500).json({ message: 'Server error during authentication' });
    }

    if (previousJti) {
      await revokeJti(previousJti, { userId: user._id || user.id, expSeconds: decoded.exp });
    } else {
      console.warn('Refresh rotation for a pre-jti token; its jti cannot be revoked individually.');
    }

    res.status(200).json({
      success: true,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user._id || user.id,
        email: user.email,
        fullName: user.fullName || user.full_name || user.name,
        role: user.role,
        isVerified: user.isVerified ?? user.is_verified ?? false
      }
    });
  } catch (error) {
    console.error('Refresh token error:', error.message);
    // What survives to this branch: a blacklist-lookup throw (infrastructure -> 503 "retry") or jwt.verify errors on
    // malformed/undecodable signatures (genuine rejection -> 401). Profile-read failures never reach here — they are
    // classified at their own call site above so an outage can never masquerade as a bad credential.
    const infrastructure = /revocation lookup failed/i.test(error.message || '');
    res.status(infrastructure ? 503 : 401).json({
      message: infrastructure ? 'Refresh is temporarily unavailable, retry shortly' : 'Invalid refresh token'
    });
  }
});

module.exports = router;
