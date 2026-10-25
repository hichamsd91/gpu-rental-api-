/**
 * Audit trail service — append-only record of privileged actions.
 *
 * Why it exists: a ban, a refund or a cross-tenant deletion has to be explainable
 * months later. Migration 007 makes the table append-only at the database level;
 * this module is the only writer.
 *
 * Failure posture: auditing must never break the request it describes. Every
 * database failure is logged and swallowed — a missing audit row is bad, a
 * failed rental because the audit table hiccuped is worse.
 */
const { getSupabaseClient } = require('../config/supabase');

const TABLE = 'audit_log';
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_ITEMS = 50;
const MAX_USER_AGENT = 300;
const MAX_IP = 64;

// Anything that looks like a credential is replaced before it can reach storage.
const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|card(number)?|cvv|ssn|otp|refresh)/i;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Deep-copies a metadata value with secrets redacted and size bounded.
 * Exported for tests: redaction is a security boundary, not a formatting detail.
 */
const sanitizeMeta = (value, depth = 0) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitizeMeta(item, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeMeta(item, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, MAX_STRING);
};

const normalizeIp = (ip) => {
  if (!ip) return null;
  const first = String(ip).split(',')[0].trim();
  return first ? first.slice(0, MAX_IP) : null;
};

/**
 * Persist one audit entry. Returns true when written, false when the write was
 * dropped (never throws for infrastructure reasons).
 */
const record = async ({
  actorId = null,
  actorRole = null,
  action,
  entity = null,
  entityId = null,
  ip = null,
  userAgent = null,
  requestId = null,
  meta = {}
} = {}) => {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new TypeError('audit action is required');
  }

  const row = {
    actor_id: actorId || null,
    actor_role: actorRole || null,
    action: action.trim().slice(0, 120),
    entity: entity ? String(entity).slice(0, 60) : null,
    entity_id: entityId !== null && entityId !== undefined ? String(entityId).slice(0, 120) : null,
    ip: normalizeIp(ip),
    user_agent: userAgent ? String(userAgent).slice(0, MAX_USER_AGENT) : null,
    request_id: requestId ? String(requestId).slice(0, 120) : null,
    meta: sanitizeMeta(meta) || {}
  };

  try {
    const client = getSupabaseClient(true);
    const { error } = await client.from(TABLE).insert(row);
    if (error) {
      console.error('audit write failed:', error.message || String(error));
      return false;
    }
    return true;
  } catch (error) {
    console.error('audit write failed:', error.message || String(error));
    return false;
  }
};

/** Convenience wrapper for Express handlers: pulls actor/request context off req. */
const recordFromRequest = (req, action, { entity = null, entityId = null, meta = {} } = {}) => {
  if (!req) return Promise.resolve(false);
  return record({
    actorId: req.user?.id || null,
    actorRole: req.user?.role || null,
    action,
    entity,
    entityId,
    ip: req.headers?.['x-forwarded-for'] || req.ip,
    userAgent: req.headers?.['user-agent'],
    requestId: req.headers?.['x-request-id'],
    meta
  });
};

/** Bounded read for the future admin panel. */
const list = async ({ entity = null, entityId = null, actorId = null, action = null, limit = 50 } = {}) => {
  const size = Math.max(1, Math.min(Number(limit) || 50, 200));
  const client = getSupabaseClient(true);
  let query = client.from(TABLE).select('*').order('created_at', { ascending: false }).limit(size);
  if (entity) query = query.eq('entity', entity);
  if (entityId) query = query.eq('entity_id', String(entityId));
  if (actorId) query = query.eq('actor_id', actorId);
  if (action) query = query.eq('action', action);

  const { data, error } = await query;
  if (error) throw new Error(`audit read failed: ${error.message}`);
  return data || [];
};

module.exports = { record, recordFromRequest, list, sanitizeMeta, TABLE };
