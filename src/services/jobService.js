/**
 * Job queue service — durable background work (settlement, timeouts, payouts).
 *
 * Storage is the `jobs` table (migration 007). Two SQL functions do the part
 * that must be atomic:
 *   claim_jobs(worker, batch)  -> SELECT ... FOR UPDATE SKIP LOCKED + mark running
 *   finish_job(id, status, err)-> succeed, or re-queue with exponential backoff
 *
 * Doing the claim in Node instead would let two workers pick the same row and
 * settle a rental twice. That is the whole reason this module is thin.
 */
const { getSupabaseClient } = require('../config/supabase');

const TABLE = 'jobs';
const MAX_BATCH = 50;
const MAX_ERROR = 2000;
const KINDS = new Set([
  'rental.settle',
  'rental.auto_stop',
  'rental.expire',
  'payout.release',
  'dispute.timeout',
  'identity.recluster',
  'notification.send'
]);

const assertKind = (kind) => {
  if (typeof kind !== 'string' || kind.trim() === '') throw new TypeError('job kind is required');
  const value = kind.trim();
  // Unknown kinds are programmer errors: a typo would otherwise sit in the queue
  // forever because no worker claims it.
  if (!KINDS.has(value)) throw new TypeError(`unknown job kind: ${value}`);
  return value;
};

/**
 * Enqueue a job. With `dedupeKey`, a second enqueue of the same key is a no-op
 * (returns { id: null, deduped: true }) — the database enforces it, not this code.
 */
const enqueue = async (kind, payload = {}, { runAfter = null, maxAttempts = 5, dedupeKey = null } = {}) => {
  const normalizedKind = assertKind(kind);
  if (payload !== null && typeof payload !== 'object') {
    throw new TypeError('job payload must be an object');
  }

  const row = {
    kind: normalizedKind,
    payload: payload || {},
    max_attempts: Math.max(1, Math.min(Number(maxAttempts) || 5, 50))
  };
  if (runAfter) {
    const when = runAfter instanceof Date ? runAfter : new Date(runAfter);
    if (Number.isNaN(when.getTime())) throw new TypeError('runAfter is not a valid date');
    row.run_after = when.toISOString();
  }
  if (dedupeKey) row.dedupe_key = String(dedupeKey).slice(0, 200);

  const client = getSupabaseClient(true);

  if (row.dedupe_key) {
    const { data, error } = await client
      .from(TABLE)
      .upsert(row, { onConflict: 'dedupe_key', ignoreDuplicates: true })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`job enqueue failed: ${error.message}`);
    return data?.id ? { id: data.id, deduped: false } : { id: null, deduped: true };
  }

  const { data, error } = await client.from(TABLE).insert(row).select('id').single();
  if (error) throw new Error(`job enqueue failed: ${error.message}`);
  return { id: data.id, deduped: false };
};

/** Claim up to `batch` due jobs for this worker. Returns the claimed rows. */
const claim = async ({ worker, batch = 1 } = {}) => {
  if (typeof worker !== 'string' || worker.trim() === '') throw new TypeError('worker id is required');
  const size = Math.max(1, Math.min(Number(batch) || 1, MAX_BATCH));

  const client = getSupabaseClient(true);
  const { data, error } = await client.rpc('claim_jobs', {
    p_worker: worker.trim().slice(0, 120),
    p_batch: size
  });
  if (error) throw new Error(`job claim failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
};

/**
 * Report a claimed job's outcome. On 'failed' the database decides between a
 * retry (with backoff) and the 'dead' state — that logic must not be duplicated
 * in Node, or two schedulers could disagree about the attempt count.
 */
const finish = async (id, { status, error = null } = {}) => {
  if (!id) throw new TypeError('job id is required');
  if (status !== 'succeeded' && status !== 'failed') {
    throw new TypeError(`invalid finish status: ${status}`);
  }

  const client = getSupabaseClient(true);
  const { data, error: rpcError } = await client.rpc('finish_job', {
    p_id: id,
    p_status: status,
    p_error: error ? String(error).slice(0, MAX_ERROR) : null
  });
  if (rpcError) throw new Error(`job finish failed: ${rpcError.message}`);
  return data;
};

const succeed = (id) => finish(id, { status: 'succeeded' });
const fail = (id, error) => finish(id, { status: 'failed', error: error?.message ? error.message : String(error || 'unknown error') });

/** Small helper for the future dashboard: queue depth by status. */
const stats = async () => {
  const client = getSupabaseClient(true);
  const counts = {};
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'dead']) {
    const { count, error } = await client
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    if (error) throw new Error(`job stats failed: ${error.message}`);
    counts[status] = count || 0;
  }
  return counts;
};

module.exports = { enqueue, claim, finish, succeed, fail, stats, KINDS, TABLE, MAX_BATCH };
