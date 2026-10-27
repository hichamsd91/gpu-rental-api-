/**
 * Idempotency for mutations that must never run twice (P3-03).
 *
 * The client sends an `Idempotency-Key` header it generated once and persisted
 * BEFORE the first attempt. Retrying with the same key — after a timeout, a lost
 * connection, a browser refresh or a flaky mobile network — replays the stored
 * answer instead of re-running the operation. That turns "did my order go
 * through?" from a guess into a fact.
 *
 * Rules:
 *   - Same key + same body  -> replay the original status/body (no side effects).
 *   - Same key + other body -> 409 idempotency_conflict (a key is one intent).
 *   - Key still in flight   -> 409 idempotency_inflight (+ Retry-After).
 *   - Failure stored as 5xx -> the row is released so a transient outage can be
 *     retried; 4xx failures are replayed verbatim (they are deterministic).
 *
 * Without migration 013 this answers 503 orders_unavailable instead of breaking
 * unrelated endpoints.
 */
const crypto = require('crypto');
const { getSupabaseClient } = require('../config/supabase');

const TABLE = 'idempotency_keys';

// A crashed/restarted API can leave a claim behind. After this long another
// attempt may take the key over — long enough that a slow request still wins.
const IN_FLIGHT_TTL_MS = 2 * 60 * 1000;

class IdempotencyError extends Error {
  constructor(message, code = 'idempotency_error', status = 409, extra = {}) {
    super(message);
    this.name = 'IdempotencyError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const isMissingSchema = (error) => {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.code === '42P01' ||
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    msg.includes('schema cache') ||
    msg.includes('does not exist')
  );
};

const hashBody = (body) =>
  crypto.createHash('sha256').update(JSON.stringify(body === undefined ? null : body)).digest('hex');

const isValidKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(key);

const replay = (row) => ({
  replay: true,
  status: row.response_status || 200,
  body: row.response_body || {}
});

const release = async ({ userId, key }) => {
  try {
    await getSupabaseClient(true).from(TABLE).delete().eq('user_id', userId).eq('key', key);
  } catch (error) {
    console.warn('idempotency: could not release key:', error.message || String(error));
  }
};

/**
 * Runs `handler` at most once per (userId, key).
 *
 * @param {object}  options
 * @param {string}  options.userId
 * @param {string}  options.key       raw Idempotency-Key header
 * @param {string}  options.scope     endpoint name, e.g. 'orders.reserve'
 * @param {*}       options.body      request payload used for the fingerprint
 * @param {Function} options.handler  async () => { status, body }
 * @param {boolean} options.memoizeFailures  cache a thrown error too (default false)
 */
const run = async ({ userId, key, scope, body, handler, memoizeFailures = false }) => {  if (!isValidKey(key)) {
    throw new IdempotencyError(
      'A valid Idempotency-Key header (8-80 letters, digits, - or _) is required for this operation',
      'idempotency_key_required',
      400
    );
  }
  if (typeof handler !== 'function') throw new Error('idempotency.run requires a handler');

  const requestHash = hashBody(body);
  const db = getSupabaseClient(true);

  const { error: claimError } = await db.from(TABLE).insert([{
    user_id: userId,
    key,
    scope,
    request_hash: requestHash,
    status: 'in_flight'
  }]);

  if (claimError) {
    if (isMissingSchema(claimError)) {
      throw new IdempotencyError(
        'Orders are not available on this deployment yet (migration 013 not applied).',
        'orders_unavailable',
        503
      );
    }
    if (claimError.code !== '23505') {
      throw new IdempotencyError(
        `Could not claim the idempotency key: ${claimError.message}`,
        'idempotency_unavailable',
        503
      );
    }

    // Someone already owns this key: decide between replay / conflict / take-over.
    const { data: existing, error: readError } = await db
      .from(TABLE)
      .select('scope, request_hash, status, response_status, response_body, updated_at')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();

    if (readError) {
      throw new IdempotencyError(
        `Could not read the idempotency key: ${readError.message}`,
        'idempotency_unavailable',
        503
      );
    }
    if (!existing) {
      // Vanished between insert and read (too old, swept): retry once.
      throw new IdempotencyError('Please retry the request', 'idempotency_retry', 409);
    }

    if (existing.scope !== scope || existing.request_hash !== requestHash) {
      throw new IdempotencyError(
        'This Idempotency-Key was already used with a different request',
        'idempotency_conflict',
        409
      );
    }

    if (existing.status === 'succeeded') return replay(existing);

    if (existing.status === 'failed') {
      const status = existing.response_status || 500;
      if (status >= 500) {
        // Transient failure: let this attempt try again under the same key.
        await db.from(TABLE)
          .update({ status: 'in_flight', updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('key', key);
      } else {
        return replay(existing);
      }
    }

    if (existing.status === 'in_flight') {
      const startedAt = new Date(existing.updated_at || 0).getTime();
      if (Number.isFinite(startedAt) && Date.now() - startedAt < IN_FLIGHT_TTL_MS) {
        throw new IdempotencyError(
          'An identical request is still being processed',
          'idempotency_inflight',
          409,
          { retryAfterSeconds: Math.ceil((IN_FLIGHT_TTL_MS - (Date.now() - startedAt)) / 1000) }
        );
      }
      // A stale claim (crashed worker): take it over.
      await db.from(TABLE)
        .update({ status: 'in_flight', updated_at: new Date().toISOString(), request_hash: requestHash })
        .eq('user_id', userId).eq('key', key);
    }
  }

  let result;
  try {
    result = await handler();
  } catch (error) {
    if (!memoizeFailures) {
      // Nothing was committed — every RPC here is all-or-nothing — so releasing
      // the claim keeps the same key usable. "Listing busy right now" must not
      // be cached forever as the answer to this key.
      await release({ userId, key });
      throw error;
    }
    const status = Number(error && error.status) || 500;
    await db.from(TABLE).update({
      status: 'failed',
      response_status: status,
      response_body: {
        message: (error && error.message) || 'Request failed',
        code: (error && error.code) || 'error'
      },
      updated_at: new Date().toISOString()
    }).eq('user_id', userId).eq('key', key);
    throw error;
  }

  const status = Number(result && result.status) || 200;
  const responseBody = (result && result.body) || {};

  const { error: storeError } = await db.from(TABLE).update({
    status: 'succeeded',
    response_status: status,
    response_body: responseBody,
    updated_at: new Date().toISOString()
  }).eq('user_id', userId).eq('key', key);

  if (storeError) {
    // The mutation already happened; failing now would make the client retry a
    // completed operation. Log loudly and still return the real answer.
    console.error('idempotency: could not store the response:', storeError.message);
  }

  return { replay: false, status, body: responseBody };
};

module.exports = {
  IdempotencyError,
  IN_FLIGHT_TTL_MS,
  hashBody,
  isValidKey,
  release,
  run
};
