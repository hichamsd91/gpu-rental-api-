const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const sessionService = require('../services/sessionService');

// One random `jti` per login/refresh cycle, signed into BOTH tokens of the
// pair. That is what makes server-side revocation (POST /auth/logout ->
// auth_blacklist, see migrations/004_auth_refresh_blacklist.sql) possible:
// without a stable id inside the token there is nothing to blacklist.
const generateTokens = async (userId) => {
  const jti = crypto.randomUUID();
  const claims = { id: userId, jti };

  const accessToken = jwt.sign(
    claims,
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );

  const refreshToken = jwt.sign(
    claims,
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' }
  );

  // The jti is returned so the caller can register this pair in `sessions`
  // (migration 011) and later kill exactly this device.
  return { accessToken, refreshToken, jti };
};

// The response is sent INSIDE a try/catch: a token-generation failure must
// return a 500, never hang the request forever (peer-review fix — the old
// version answered inside a bare .then() with no .catch()).
//
// `options.req` (optional) enables the active-session inventory: the issued
// pair is recorded so the user can later see and kill this device. Recording is
// best-effort and can never fail a sign-in.
const sendTokenResponse = async (user, statusCode, res, options = {}) => {
  const { extra = {}, req = null } = options;
  const userId = user._id || user.id;
  try {
    const tokens = await generateTokens(userId);

    if (req) {
      try {
        await sessionService.record({ userId, jti: tokens.jti, req });
      } catch (error) {
        console.error('Could not record the session:', error.message || String(error));
      }
    }

    res.status(statusCode).json({
      success: true,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: userId,
        email: user.email,
        fullName: user.fullName || user.full_name || user.name,
        role: user.role,
        isVerified: user.isVerified ?? user.is_verified ?? false
      },
      // Callers may attach a small, non-secret result flag (e.g. whether the
      // verification email was queued).
      ...extra
    });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ message: 'Server error during authentication' });
  }
};

module.exports = { generateTokens, sendTokenResponse };
