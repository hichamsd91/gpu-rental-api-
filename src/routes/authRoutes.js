const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { UserService } = require('../services/supabaseService');
const { getSupabaseClient } = require('../config/supabase');
const { sendTokenResponse } = require('../utils/token');
const { validateRequest } = require('../middleware/validation');
const { body } = require('express-validator');

const normalizeEmail = email => String(email || '').trim().toLowerCase();

// === Refresh-token revocation (jti blacklist) ================================
// See migrations/004_auth_refresh_blacklist.sql. Tokens are revoked by their
// `jti` claim (see utils/token.js). Authenticity is ALWAYS established with a
// real signature check — never with an unverified decode of attacker input;
// `ignoreExpiration: true` still requires the correct HS256 secret, so a fake
// token cannot forge jti/userId pairs into the blacklist.

const BLACKLIST_TABLE = 'auth_blacklist'; // SUPABASE_TABLES is snake_case-safe for ad-hoc tables

async function isJtiBlacklisted(jti) {
  if (!jti) return false;
  const client = getSupabaseClient(true); // service role: reads must not depend on RLS state
  const { data, error } = await client.from(BLACKLIST_TABLE).select('jti').eq('jti', jti).maybeSingle();
  if (error) {
    // Additive-migration degradation: while the table does not exist yet (the
    // typical pre-004 state on a fresh deploy) we keep the pre-004 behaviour
    // instead of taking every refresh request down.
    console.error(`auth_blacklist check failed for jti ${String(jti).slice(0, 8)}…:`, error.message);
    return false;
  }
  return Boolean(data);
}

async function persistBlacklistEntry({ jti, userId, expSeconds }) {
  const client = getSupabaseClient(true);
  // Keep the row slightly past the original expiry so a late rotation that
  // carries this same jti still finds it (cleanup job prunes expired rows).
  const expiresAt = Number.isFinite(expSeconds) ? new Date((expSeconds + 2 * 60 * 60) * 1000).toISOString() : null;
  const { error } = await client.from(BLACKLIST_TABLE).upsert(
    { jti, user_id: userId || null, created_at: new Date().toISOString(), expires_at: expiresAt },
    { onConflict: 'jti' }
  );
  return !error; // false when migration 004 has not been applied yet (or DB down)
}

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

    const persisted = await persistBlacklistEntry({ jti: decoded.jti, userId: decoded.id, expSeconds: decoded.exp });

    if (persisted) {
      console.log(`Refresh token ${decoded.jti} for user ${decoded.id} revoked.`);
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

    const user = await UserService.findById(decoded.id);

    if (!user || user.isActive === false) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    sendTokenResponse(user, 200, res);
  } catch (error) {
    console.error('Refresh token error:', error.message);
    res.status(401).json({ message: 'Invalid refresh token' });
  }
});

module.exports = router;
