const express = require('express');
const router = express.Router();
const crypto = require('crypto');
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
const { auth } = require('../middleware/auth');
const { issue: issueEmailToken, consume: consumeEmailToken, revokeAllForUser, PURPOSE } = require('../services/emailTokenService');
const { sendVerificationEmail, sendPasswordResetEmail, sendInBackground } = require('../services/mailerService');
const { passport, googleEnabled, githubEnabled } = require('../config/passport');
const oauth = require('../services/oauthService');
const sessions = require('../services/sessionService');

// Passport needs req._passport before passport.authenticate() runs. No session
// middleware is used: this API is stateless and every flow ends in our own JWT.
router.use(passport.initialize());

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

    // Queue the verification link right after the account exists. SMTP latency
    // (11–23s on a real network) must never delay or fail a signup, so the send
    // is detached; the user can always ask for another link from the app.
    let verificationEmailQueued = false;
    try {
      const token = await issueEmailToken({ userId: createdUser.id, purpose: PURPOSE.VERIFY_EMAIL });
      sendInBackground(sendVerificationEmail(createdUser.email, token));
      verificationEmailQueued = true;
    } catch (tokenError) {
      console.error('Register: could not queue verification email:', tokenError.message || String(tokenError));
    }

    sendTokenResponse(createdUser, 201, res, { extra: { verificationEmailQueued }, req });
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

    // The commission-ledger system account must never be a login target.
    if (oauth.isPlatformAccount(user.id)) {
      return res.status(403).json({ message: 'This system account cannot sign in' });
    }

    await UserService.updateLastLogin(user.id);
    sendTokenResponse(user, 200, res, { req });
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

    // Retire the inventory row too (no-op if migration 011 is not applied yet).
    await sessions.revokeByJti({ jti: decoded.jti, userId: decoded.id });

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

    if (oauth.isPlatformAccount(user.id)) {
      return res.status(401).json({ message: 'Invalid refresh token' });
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

    // The inventory follows the rotation: the old device row is retired and the
    // new pair takes its place (best-effort — never blocks the refresh).
    await sessions
      .rotate({ userId: user._id || user.id, oldJti: previousJti, newJti: tokens.jti, req })
      .catch((error) => console.error('Session rotation failed:', error.message || String(error)));

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

// @desc    Request a fresh email-verification link
// @route   POST /api/auth/verify-email/resend
// @access  Private
router.post('/verify-email/resend', auth, async (req, res) => {
  try {
    const user = req.user;
    if (user.isVerified === true || user.is_verified === true) {
      return res.json({ success: true, alreadyVerified: true });
    }

    const token = await issueEmailToken({ userId: user._id || user.id, purpose: PURPOSE.VERIFY_EMAIL });
    sendInBackground(sendVerificationEmail(user.email, token));

    res.json({ success: true, message: 'Verification email queued' });
  } catch (error) {
    console.error('Verify email resend error:', error.message || String(error));
    res.status(500).json({ message: 'Server error sending verification email' });
  }
});

// @desc    Confirm an email-verification link
// @route   GET /api/auth/verify-email?token=...
// @access  Public
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ message: 'Token is required' });
    }

    const userId = await consumeEmailToken(token, PURPOSE.VERIFY_EMAIL);
    if (!userId) {
      return res.status(400).json({ message: 'Verification link is invalid or expired' });
    }

    await UserService.markVerified(userId);
    res.json({ success: true, message: 'Email verified' });
  } catch (error) {
    console.error('Verify email error:', error.message || String(error));
    res.status(500).json({ message: 'Server error during verification' });
  }
});

// @desc    Request a password-reset link (never reveals whether the email exists)
// @route   POST /api/auth/forgot-password
// @access  Public
router.post('/forgot-password', validateRequest([
  body('email').isEmail().withMessage('Valid email is required')
]), async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);
    const user = await UserService.findByEmail(normalizedEmail);

    // Constant response whether or not the account exists (no user enumeration)
    // — and constant TIMING too: the send is detached, so a known address does
    // not answer seconds later than an unknown one.
    if (user) {
      const token = await issueEmailToken({ userId: user.id, purpose: PURPOSE.RESET_PASSWORD });
      sendInBackground(sendPasswordResetEmail(user.email, token));
    }

    res.json({ success: true, message: 'If that email exists, a reset link has been sent' });
  } catch (error) {
    console.error('Forgot password error:', error.message || String(error));
    res.status(500).json({ message: 'Server error requesting password reset' });
  }
});

// @desc    Reset a password with a one-time token
// @route   POST /api/auth/reset-password
// @access  Public
router.post('/reset-password', validateRequest([
  body('token').notEmpty().withMessage('Token is required'),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
]), async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    const userId = await consumeEmailToken(token, PURPOSE.RESET_PASSWORD);
    if (!userId) {
      return res.status(400).json({ message: 'Reset link is invalid or expired' });
    }

    const updated = await UserService.updatePassword(userId, newPassword);
    if (!updated) {
      return res.status(404).json({ message: 'Account not found' });
    }

    // Invalidate any other outstanding reset links for this user.
    await revokeAllForUser(userId, PURPOSE.RESET_PASSWORD).catch(() => {});

    // …and every session that was opened with the old password: a stolen
    // refresh token must not outlive the reset that was meant to kill it.
    await sessions.revokeAllExcept({ userId }).catch((error) => {
      console.error('Reset password: could not revoke sessions:', error.message || String(error));
    });

    res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error.message || String(error));
    res.status(500).json({ message: 'Server error resetting password' });
  }
});

// @desc    Which social providers are configured on this deployment
// @route   GET /api/auth/providers
// @access  Public
// The client hides buttons for providers that would only answer 503. No secret
// is exposed — this is a boolean per provider, nothing more.
router.get('/providers', (req, res) => {
  res.json({ google: googleEnabled, github: githubEnabled });
});

// ============================================
// ACTIVE SESSIONS (P1-05)
// ============================================
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessionsUnavailable = (res, error) =>
  res.status(503).json({ message: error.message, code: 'sessions_unavailable' });

// @desc    The devices currently signed in with this account
// @route   GET /api/auth/sessions
// @access  Private
router.get('/sessions', auth, async (req, res) => {
  try {
    const rows = await sessions.listActive(req.user.id || req.user._id);
    res.json({
      success: true,
      sessions: rows.map((row) => ({
        id: row.id,
        userAgent: row.user_agent,
        ipAddress: row.ip_address,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        current: row.jti === req.authJti
      }))
    });
  } catch (error) {
    if (error instanceof sessions.SessionsUnavailable) return sessionsUnavailable(res, error);
    console.error('List sessions error:', error.message || String(error));
    res.status(500).json({ message: 'Server error listing sessions' });
  }
});

// @desc    End one session (its access AND refresh token die immediately)
// @route   POST /api/auth/sessions/:id/revoke
// @access  Private
router.post('/sessions/:id/revoke', auth, async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ message: 'Invalid session id' });
  }
  try {
    const revoked = await sessions.revokeOne({ userId: req.user.id || req.user._id, sessionId: id });
    // A session id belonging to somebody else answers exactly like a missing
    // one, so ids cannot be probed across accounts.
    if (!revoked) return res.status(404).json({ message: 'Session not found' });
    res.json({ success: true, message: 'Session ended' });
  } catch (error) {
    if (error instanceof sessions.SessionsUnavailable) return sessionsUnavailable(res, error);
    console.error('Revoke session error:', error.message || String(error));
    res.status(500).json({ message: 'Server error revoking the session' });
  }
});

// @desc    End every other session (keep the one calling this endpoint)
// @route   POST /api/auth/sessions/revoke-others
// @access  Private
router.post('/sessions/revoke-others', auth, async (req, res) => {
  try {
    const count = await sessions.revokeAllExcept({
      userId: req.user.id || req.user._id,
      keepJti: req.authJti
    });
    res.json({ success: true, revoked: count });
  } catch (error) {
    if (error instanceof sessions.SessionsUnavailable) return sessionsUnavailable(res, error);
    console.error('Revoke other sessions error:', error.message || String(error));
    res.status(500).json({ message: 'Server error revoking the other sessions' });
  }
});

// ============================================
// SOCIAL SIGN-IN (Google / GitHub)
// ============================================
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://veloxora-app.web.app';
const OAUTH_CODE_PURPOSE = 'oauth_exchange';

// The callback never puts tokens in the URL. It redirects with a signed,
// 2-minute, single-use code that the client exchanges for a real token pair —
// so a leaked browser history entry cannot be replayed as a session.
const issueOAuthCode = (userId) =>
  jwt.sign(
    { id: userId, purpose: OAUTH_CODE_PURPOSE, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '2m' }
  );

// OAuth login CSRF: without a `state` value the callback accepts a code that an
// attacker started, which logs the victim into the attacker's account. The
// state is signed, bound to a HttpOnly cookie and checked before the exchange.
const OAUTH_STATE_PURPOSE = 'oauth_state';
const OAUTH_STATE_COOKIE = (name) => `oauth_state_${name}`;

const issueOAuthState = () =>
  jwt.sign(
    { purpose: OAUTH_STATE_PURPOSE, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );

const consumeOAuthState = (req, res, name) => {
  const cookieName = OAUTH_STATE_COOKIE(name);
  const expected = (req.cookies && req.cookies[cookieName]) || '';
  res.clearCookie(cookieName, { path: '/' });
  const received = typeof req.query.state === 'string' ? req.query.state : '';
  if (!expected || !received) return false;
  try {
    const decoded = jwt.verify(expected, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.purpose !== OAUTH_STATE_PURPOSE) return false;
  } catch {
    return false;
  }
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const registerProviderRoutes = (name, enabled) => {
  router.get(`/${name}`, (req, res, next) => {
    if (!enabled) {
      return res.status(503).json({ message: `${name} sign-in is not configured` });
    }
    const state = issueOAuthState();
    res.cookie(OAUTH_STATE_COOKIE(name), state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 10 * 60 * 1000,
      path: '/'
    });
    return passport.authenticate(name, { session: false, state })(req, res, next);
  });

  router.get(`/${name}/callback`, (req, res, next) => {
    if (!enabled) {
      return res.status(503).json({ message: `${name} sign-in is not configured` });
    }
    const fail = (reason) => res.redirect(`${FRONTEND_URL}/#/login?error=${encodeURIComponent(reason)}`);
    if (!consumeOAuthState(req, res, name)) return fail('oauth_state_mismatch');
    passport.authenticate(name, { session: false }, async (err, result) => {
      if (err || !result) return fail(err?.code || 'oauth_failed');
      try {
        const { user } = await oauth.linkOrCreate(result.provider, result.profile);
        const code = issueOAuthCode(user.id || user._id);
        return res.redirect(`${FRONTEND_URL}/#/oauth/callback?code=${encodeURIComponent(code)}`);
      } catch (error) {
        const reason = error.code || 'oauth_failed';
        console.error(`${name} oauth callback error:`, reason, error.message || String(error));
        return fail(reason);
      }
    })(req, res, next);
  });
};

registerProviderRoutes('google', googleEnabled);
registerProviderRoutes('github', githubEnabled);

// @desc    Exchange a one-time OAuth code for a token pair
// @route   POST /api/auth/oauth/exchange
// @access  Public (code is signed and single-use)
router.post('/oauth/exchange', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ message: 'Code is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(code, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ message: 'Invalid or expired code' });
    }
    if (decoded.purpose !== OAUTH_CODE_PURPOSE || !decoded.id) {
      return res.status(401).json({ message: 'Invalid code' });
    }

    // Single-use: a code already spent (or revoked) dies here.
    const spent = await isJtiBlacklisted(decoded.jti);
    if (spent) return res.status(401).json({ message: 'Code already used' });
    await revokeJti(decoded.jti, { userId: decoded.id, expSeconds: decoded.exp });

    const user = await UserService.findById(decoded.id);
    if (!user || user.isActive === false || user.is_active === false) {
      return res.status(401).json({ message: 'Account is not available' });
    }
    if (oauth.isPlatformAccount(user.id)) {
      return res.status(403).json({ message: 'This system account cannot sign in' });
    }

    const tokens = await generateTokens(user.id);
    await sessions.record({ userId: user.id, jti: tokens.jti, req });
    return res.json({
      success: true,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName || user.full_name,
        role: user.role,
        isVerified: user.isVerified ?? user.is_verified ?? true
      }
    });
  } catch (error) {
    console.error('oauth exchange error:', error.message || String(error));
    return res.status(500).json({ message: 'Server error during sign-in' });
  }
});

module.exports = router;
