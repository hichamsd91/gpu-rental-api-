const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const { validateEnvironment, isProduction } = require('./config/env');
const { connectDB } = require('./config/database');

const envConfig = validateEnvironment();

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const gpuRoutes = require('./routes/gpuRoutes');
const listingRoutes = require('./routes/listingRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const rentalRoutes = require('./routes/rentalRoutes');
const signalingRoutes = require('./routes/signalingRoutes');

const app = express();
app.set('trust proxy', 1);

const configuredOrigins = envConfig.corsOrigins;

const corsOptions = {
  credentials: true,
  origin: (origin, callback) => {
    if (!origin || configuredOrigins.includes('*') || configuredOrigins.includes(origin)) {
      return callback(null, true);
    }

    const error = new Error('Origin is not allowed by CORS');
    error.status = 403;
    return callback(error);
  }
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.'
  },
  skipSuccessfulRequests: true
});

const parsePort = value => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 5000;
};

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: !isProduction,
  crossOriginResourcePolicy: { policy: 'same-site' },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  referrerPolicy: { policy: 'no-referrer' },
  xContentTypeOptions: true,
  xDNSPrefetchControl: false,
  xXssProtection: false
}));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(cors(corsOptions));
app.use(compression());
app.use(cookieParser());
app.use(express.json({
  limit: envConfig.jsonBodyLimit
}));
app.use(express.urlencoded({
  extended: true,
  limit: envConfig.urlencodedBodyLimit
}));

// Health check BEFORE rate limiting
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: process.env.PLATFORM_NAME || 'Veloxora API'
  });
});

app.use(rateLimit({
  windowMs: envConfig.rateLimitWindowMs,
  limit: envConfig.rateLimitMaxRequests,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));
app.use('/api/auth', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/gpus', gpuRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/rentals', rentalRoutes);
app.use('/api/signaling', signalingRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON payload'
    });
  }

  const statusCode = error.statusCode || error.status || 500;
  const message = statusCode >= 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : error.message || 'Internal server error';

  if (statusCode >= 500) {
    console.error(error);
  }

  return res.status(statusCode).json({
    success: false,
    message
  });
});

let server;
let shuttingDown = false;

const closeServer = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  } catch (error) {
    console.error('Graceful shutdown error:', error);
    throw error;
  }
};

const startServer = async () => {
  await connectDB();

  const port = parsePort(process.env.PORT || envConfig.port);
  server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  console.log(`Veloxora API listening on port ${port}`);
  return server;
};

const handleShutdownSignal = signal => {
  console.log(`${signal} received. Shutting down gracefully...`);
  closeServer()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
};

if (require.main === module) {
  process.once('SIGINT', () => handleShutdownSignal('SIGINT'));
  process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'));

  startServer().catch(error => {
    console.error('Unable to start server:', error);
    process.exitCode = 1;
  });
}

// Export the app itself for HTTP tests and expose lifecycle helpers for callers
// that manage the process explicitly.
module.exports = app;
module.exports.app = app;
module.exports.startServer = startServer;
module.exports.closeServer = closeServer;
