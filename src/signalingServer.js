const http = require('http');
const url = require('url');
const { StringDecoder } = require('string_decoder');

const routes = {};

function register(method, path, handler) {
  routes[`${method.toUpperCase()}:${path}`] = handler;
}

function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const method = req.method || 'GET';
  const pathname = parsed.pathname || '/';
  const query = parsed.query || {};
  const key = `${method.toUpperCase()}:${pathname}`;
  const handler = routes[key];

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return;
  }

  const decoder = new StringDecoder('utf8');
  let body = {};
  req.on('data', chunk => {});
  req.on('end', () => {
    try { body = JSON.parse(decoder.toString() || '{}'); } catch (e) { body = {}; }
    if (!handler) {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'Not found' }));
      return;
    }
    try {
      const result = handler({ method, pathname, query, body }, res);
      if (result && result.then) {
        result.then(data => {
          res.writeHead(200);
          res.end(JSON.stringify(data));
        }).catch(err => {
          res.writeHead(500);
          res.end(JSON.stringify({ success: false, message: err.message || 'Server error' }));
        });
      } else if (result !== undefined) {
        res.writeHead(200);
        res.end(JSON.stringify(result));
      }
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, message: err.message || 'Server error' }));
    }
  });
}

const server = http.createServer(handleRequest);

register('GET', '/health', () => ({ success: true, timestamp: new Date().toISOString(), service: 'Veloxora Signaling' }));
register('POST', '/api/auth/register', (req) => {
  const { email, password, fullName, role = 'renter' } = req.body || {};
  if (!email || !password || !fullName) throw new Error('Missing required fields');
  return { success: true, message: 'Registered', user: { email, fullName, role } };
});
register('POST', '/api/auth/login', (req) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new Error('Missing credentials');
  return { success: true, message: 'Logged in', token: 'veloxora-demo-token', user: { id: '1', email, fullName: 'Demo', role: 'renter' } };
});
register('GET', '/api/auth/me', () => ({ success: true, user: { id: '1', email: 'demo@veloxora.com', fullName: 'Demo', role: 'renter' } }));
register('GET', '/api/listings', () => ({ success: true, listings: [] }));
register('GET', '/api/rentals', () => ({ success: true, rentals: [] }));
register('GET', '/api/devices', () => ({ success: true, devices: [] }));
register('GET', '/api/gpus', () => ({ success: true, gpus: [] }));
register('GET', '/api/admin/stats', () => ({ success: true, stats: { users: 0, gpus: 0, rentals: 0, revenue: 0 } }));
register('GET', '/api/signaling/info', () => ({
  success: true,
  signaling: {
    url: 'http://localhost:5000',
    stunServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
}));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Veloxora Signaling Server running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
