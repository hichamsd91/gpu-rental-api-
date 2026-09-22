const { createClient } = require('@supabase/supabase-js');

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = require('ws');
}

const getSupabaseClient = (serviceRole = false) => {
  const url = process.env.SUPABASE_URL || '';
  const key = serviceRole
    ? (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '')
    : (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '');

  console.log('[Supabase] Config check:', {
    hasUrl: !!url,
    urlLength: url.length,
    hasKey: !!key,
    keyLength: key.length,
    isServiceRole: serviceRole
  });

  if (!url || !key) {
    throw new Error('Supabase configuration is missing. Please set SUPABASE_URL and a valid API key.');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
};

module.exports = { getSupabaseClient };