const jwt = require('jsonwebtoken');
const { UserService } = require('../services/supabaseService');
const { isJtiBlacklisted } = require('../services/revocation');

// Throws on a genuine read failure (the caller below fails closed with a transient 503) and returns null ONLY when the row
// truly does not exist. The distinction matters during outages: dressing up "we could not read your profile" as "invalid token"
// would make clients wipe their valid local state on every Supabase hiccup instead of retrying.
const findUserById = async (userId) => {
  const user = await UserService.findById(userId); // lookup failure rethrows — handled by the fail-closed catch below
  if (!user) console.warn('Auth middleware: no profile row for id', String(userId).slice(0, 8));
  return user;
};

const auth = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '') || req.cookies?.token;

  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  // Pin the algorithm: only HS256 (what generateTokens signs) is accepted. Expired or tampered tokens answer a plain
  // 401 here — they are already unauthenticated by their own signature, so no revocation lookup is consulted for them.
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    if (error && error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token has expired' });
    }
    return res.status(401).json({ message: 'Token is not valid' });
  }

  try {
    // Revocation gate: a jti blacklisted by logout or refresh rotation must fail every
    // protected route IMMEDIATELY — this turns the old "valid until TTL (7d)" gap into
    // immediate kill. Failures here are deliberate 503, not silent pass-throughs.
    if (decoded.jti && await isJtiBlacklisted(decoded.jti)) {
      return res.status(401).json({ message: 'Session has been revoked' });
    }

    const user = await findUserById(decoded.id);

    if (!user) {
      return res.status(401).json({ message: 'Token is not valid' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    req.user = user;
    next();
  } catch (error) {
    // Fail CLOSED on blacklist-lookup or profile-lookup trouble: a request whose revocation
    // status we could not check is answered 503 "temporary" — never as if the token were valid.
    console.error('Auth middleware error:', error.message || String(error));
    res.status(503).json({ message: 'Authentication is temporarily unavailable, retry shortly' });
  }
};

const adminAuth = async (req, res, next) => {
  try {
    await auth(req, res, () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Access denied. Admin only.' });
      }
      next();
    });
  } catch (error) {
    res.status(401).json({ message: 'Authorization failed' });
  }
};

const providerAuth = async (req, res, next) => {
  try {
    await auth(req, res, () => {
      if (!['provider', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Access denied. Provider only.' });
      }
      next();
    });
  } catch (error) {
    res.status(401).json({ message: 'Authorization failed' });
  }
};

const renterAuth = async (req, res, next) => {
  try {
    await auth(req, res, () => {
      if (!['renter', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Access denied. Renter only.' });
      }
      next();
    });
  } catch (error) {
    res.status(401).json({ message: 'Authorization failed' });
  }
};

module.exports = { auth, adminAuth, providerAuth, renterAuth };
