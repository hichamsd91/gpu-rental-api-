const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../../.env')
});

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const ensureValue = (key, fallback, { required = false, allowEmpty = false } = {}) => {
  const value = process.env[key];

  if (value === undefined || value === null || (!allowEmpty && String(value).trim() === '')) {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`);
    }

    if (fallback !== undefined) {
      process.env[key] = String(fallback);
      return String(fallback);
    }

    return undefined;
  }

  return String(value).trim();
};

const validateEnvironment = () => {
  const port = ensureValue('PORT', 5000, { allowEmpty: false });
  const jsonBodyLimit = ensureValue('JSON_BODY_LIMIT', '1mb');
  const urlencodedBodyLimit = ensureValue('URLENCODED_BODY_LIMIT', '1mb');
  const rateLimitWindowMs = ensureValue('RATE_LIMIT_WINDOW_MS', String(15 * 60 * 1000));
  const rateLimitMaxRequests = ensureValue('RATE_LIMIT_MAX_REQUESTS', '100');

  ensureValue('JWT_SECRET', isProduction ? undefined : 'dev-jwt-secret-change-me', {
    required: isProduction,
    allowEmpty: false
  });
  ensureValue('JWT_REFRESH_SECRET', isProduction ? undefined : 'dev-refresh-secret-change-me', {
    required: isProduction,
    allowEmpty: false
  });
  ensureValue('MONGODB_URI', isProduction ? undefined : 'mongodb://localhost:27017/gpu_rental_platform', {
    required: isProduction,
    allowEmpty: false
  });

  ensureValue('SUPABASE_URL', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_PUBLISHABLE_KEY', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_SECRET_KEY', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_SERVICE_ROLE_KEY', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_JWKS_URL', undefined, { required: false, allowEmpty: false });

  const configuredOrigins = (ensureValue('CORS_ORIGIN', 'http://localhost:3000,http://localhost:8080') || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (isProduction && configuredOrigins.length === 0) {
    throw new Error('CORS_ORIGIN is required in production to avoid exposing the API to all origins.');
  }

  if (isProduction) {
    console.info('[env] Running in production mode with validated server settings.');
  } else {
    console.info('[env] Running in development mode with local fallback secrets.');
  }

  return {
    isProduction,
    port: parsePositiveInteger(port, 5000),
    jsonBodyLimit,
    urlencodedBodyLimit,
    rateLimitWindowMs: parsePositiveInteger(rateLimitWindowMs, 15 * 60 * 1000),
    rateLimitMaxRequests: parsePositiveInteger(rateLimitMaxRequests, 100),
    corsOrigins: configuredOrigins,
    jwtSecret: process.env.JWT_SECRET,
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
    mongoDbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/gpu_rental_platform'
  };
};

module.exports = { isProduction, validateEnvironment };
