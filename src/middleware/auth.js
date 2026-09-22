const jwt = require('jsonwebtoken');
const { UserService } = require('../services/supabaseService');

const findUserById = async (userId) => {
  try {
    return await UserService.findById(userId);
  } catch (error) {
    console.warn('Supabase user lookup failed:', error.message);
    return null;
  }
};

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '') || req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: 'No token, authorization denied' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
    console.error('Auth middleware error:', error);
    res.status(401).json({ message: 'Token is not valid' });
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
