const path = require('path');

require('dotenv').config({
  path: path.resolve(__dirname, '../../.env')
});

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const isPaymentsEnabled = () => (/^(true|on|yes)$/i.test(process.env.PAYMENTS_ENABLED || '') === true);

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

  // Supabase is the only database backend. A production boot without it must
  // fail immediately; dev/test boots still come up (requests that need data
  // will fail individually) so unit tests keep working.
  const hasSupabase = Boolean(
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY)
  );

  if (!hasSupabase) {
    if (isProduction) {
      throw new Error('Supabase is not configured: set SUPABASE_URL plus a role key.');
    }
    console.warn('[env] Supabase is NOT configured — data-backed requests will fail until it is.');
  }

  ensureValue('SUPABASE_URL', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_PUBLISHABLE_KEY', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_SECRET_KEY', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_SERVICE_ROLE_KEY', undefined, { required: false, allowEmpty: false });
  ensureValue('SUPABASE_JWKS_URL', undefined, { required: false, allowEmpty: false });

  const configuredOrigins = (ensureValue('CORS_ORIGIN', 'http://localhost:3000,http://localhost:8080') || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  // A wildcard origin exposes every cross-origin caller (credential-requests
  // included). Rules:
  //   - bare "*"             -> production boot failure; dev allowed with a warning
  //   - "*" plus real list   -> drop the "*", keep exactly the explicit list
  let normalizedOrigins = configuredOrigins;
  if (normalizedOrigins.includes('*')) {
    const wildcardOnly = normalizedOrigins.length === 1;

    if (wildcardOnly) {
      if (isProduction) {
        throw new Error(
          'CORS_ORIGIN="*" is not allowed in production: list explicit https origins, e.g. https://app.example.com'
        );
      }
      console.warn('[env] CORS wide open ("*") — fine for local development, never in production.');
    } else {
      normalizedOrigins = normalizedOrigins.filter(origin => origin !== '*');
      console.warn('[env] Dropping "*" from CORS_ORIGIN (real origins were listed too) — the explicit list now applies exactly.');
    }
  }

  if (normalizedOrigins.length === 0) {
    throw new Error('CORS_ORIGIN must name at least one origin in production.');
  }

  // Payments default to OFF until a real gateway is wired up: deposit and
  // process endpoints then answer clean 503s while wallet/ledger reads stay live.
  const paymentsEnabled = isPaymentsEnabled();
  if (isProduction && !paymentsEnabled) {
    console.info('[env] PAYMENTS_ENABLED=false — payment intake disabled; wallet reads remain available.');
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
    corsOrigins: normalizedOrigins,
    jwtSecret: process.env.JWT_SECRET,
    jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
    paymentsEnabled
  };
};

module.exports = { isProduction, validateEnvironment, isPaymentsEnabled };
