/**
 * Feature flags (migration 007) — server-side kill switches.
 *
 * Failure posture is FAIL CLOSED: an unreadable or missing table answers
 * "disabled". A flag exists to stop something dangerous (payments, mining), so
 * a database hiccup must never silently re-enable it.
 *
 * A 30-second cache keeps a hot endpoint (the public purpose catalog) from
 * issuing one query per request. The TTL is short enough that flipping a flag
 * in the dashboard takes effect almost immediately.
 */
const { getSupabaseClient } = require('../config/supabase');

const TABLE = 'feature_flags';
const TTL_MS = 30 * 1000;

const cache = new Map(); // key -> { value, expiresAt }

const clearCache = () => cache.clear();

const isEnabled = async (key, { defaultValue = false } = {}) => {
  if (!key) return defaultValue;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value = defaultValue;
  try {
    const { data, error } = await getSupabaseClient(true)
      .from(TABLE)
      .select('enabled')
      .eq('key', key)
      .maybeSingle();
    if (!error && data) value = data.enabled === true;
    else if (error) console.warn(`featureFlags: could not read "${key}" — assuming disabled:`, error.message);
  } catch (error) {
    console.warn(`featureFlags: read threw for "${key}" — assuming disabled:`, error.message || String(error));
  }

  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
};

/** Resolves several flags in one round trip (used by the purpose catalog). */
const enabledMap = async (keys = []) => {
  const unique = [...new Set(keys.filter(Boolean))];
  const entries = await Promise.all(unique.map(async (key) => [key, await isEnabled(key)]));
  return Object.fromEntries(entries);
};

module.exports = { isEnabled, enabledMap, clearCache, TTL_MS };
