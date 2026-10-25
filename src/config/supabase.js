const { createClient } = require('@supabase/supabase-js');

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = require('ws');
}

// One client per role, reused across calls. createClient() is stateless, so a
// cached instance is safe; rebuilding it on every request was pure overhead and
// flooded the logs with a config line per call.
const clients = new Map();
let configLogged = false;

const getSupabaseClient = (serviceRole = false) => {
  const cacheKey = serviceRole ? 'service' : 'public';
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const url = process.env.SUPABASE_URL || '';
  const key = serviceRole
    ? (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '')
    : (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '');

  if (!configLogged) {
    console.log('[Supabase] Config check:', {
      hasUrl: !!url,
      urlLength: url.length,
      hasKey: !!key,
      keyLength: key.length,
      isServiceRole: serviceRole
    });
    configLogged = true;
  }

  if (!url || !key) {
    throw new Error('Supabase configuration is missing. Please set SUPABASE_URL and a valid API key.');
  }

  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  clients.set(cacheKey, client);
  return client;
};

module.exports = { getSupabaseClient };
