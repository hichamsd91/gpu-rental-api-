const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// One random `jti` per login/refresh cycle, signed into BOTH tokens of the
// pair. That is what makes server-side revocation (POST /auth/logout ->
// auth_blacklist, see migrations/004_auth_refresh_blacklist.sql) possible:
// without a stable id inside the token there is nothing to blacklist.
const generateTokens = async (userId) => {
  const claims = { id: userId, jti: crypto.randomUUID() };

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

  return { accessToken, refreshToken };
};

// The response is sent INSIDE a try/catch: a token-generation failure must
// return a 500, never hang the request forever (peer-review fix — the old
// version answered inside a bare .then() with no .catch()).
const sendTokenResponse = async (user, statusCode, res) => {
  const userId = user._id || user.id;
  try {
    const tokens = await generateTokens(userId);

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
      }
    });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ message: 'Server error during authentication' });
  }
};

module.exports = { generateTokens, sendTokenResponse };
