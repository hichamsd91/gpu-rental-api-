const jwt = require('jsonwebtoken');

const generateTokens = async (userId) => {
  const accessToken = jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );

  const refreshToken = jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRE || '30d' }
  );

  return { accessToken, refreshToken };
};

const sendTokenResponse = (user, statusCode, res) => {
  const userId = user._id || user.id;
  generateTokens(userId).then(tokens => {
    const options = {
      httpOnly: true,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production'
    };

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
  });
};

module.exports = { generateTokens, sendTokenResponse };
