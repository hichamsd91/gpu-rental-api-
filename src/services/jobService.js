/**
 * Session jobs — the bridge between a paid, running rental and the provider's
 * worker agent.
 *
 * The renter never gets a shell. A job is a *kind* plus numeric parameters,
 * validated against a server-side allowlist (JOB_KINDS). The provider's agent
 * claims it, executes exactly that kind with a local preset, and reports the
 * result. That keeps "renting a GPU" from turning into remote code execution on
 * a stranger's machine.
 *
 * One job per rental (primary key). Claiming is an atomic UPDATE guarded by
 * status = 'queued', so two agents can never run the same job twice.
 */
const crypto = require('crypto');
const { getSupabaseClient } = require('../config/supabase');

const TABLE = 'session_jobs';
const LOG_LIMIT = 8000;
const RESULT_LIMIT = 256 * 1024;
// A claimed job whose row has not moved for this long is treated as abandoned
// (the agent crashed): longer than the biggest preset timeout, so a healthy run
// can never be stolen mid-flight.
const STALE_CLAIM_SECONDS = 240;

class JobError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.status = status;
  }
}

const isMissingTable = (error) => error && (
  error.code === '42P01' ||
  error.code === 'PGRST205' ||
  /does not exist|schema cache/i.test(String(error.message || ''))
);

// ── The allowlist ────────────────────────────────────────────────────────────
// Every entry is a preset that ships with the worker agent. Parameters are
// numbers in a closed range — nothing here can be turned into a command.
const JOB_KINDS = {
  'render.mandelbrot': {
    purpose: 'rendering',
    label: 'GPU render (Mandelbrot)',
    timeoutSeconds: 180,
    params: {
      width: { min: 64, max: 1024, default: 320, integer: true },
      height: { min: 64, max: 1024, default: 240, integer: true },
      iterations: { min: 10, max: 500, default: 80, integer: true }
    }
  },
  'compute.matmul': {
    purpose: 'compute',
    label: 'GPU compute (matrix multiply)',
    timeoutSeconds: 300,
    params: {
      size: { min: 256, max: 4096, default: 1024, integer: true },
      repeats: { min: 1, max: 20, default: 3, integer: true }
    }
  }
};

// Which kinds a purpose may run. Mining has no executor yet: the platform
// allows a mining rental, but it must not pretend it can run the work.
const PURPOSE_KINDS = {
  rendering: ['render.mandelbrot'],
  training: ['compute.matmul'],
  inference: ['compute.matmul'],
  research: ['compute.matmul'],
  mining: []
};

const normalizeSpec = (kind, rawParams) => {
  const definition = JOB_KINDS[kind];
  if (!definition) {
    throw new JobError(`Unknown job kind "${kind}"`, 'job_kind_unknown');
  }
  const input = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? rawParams : {};
  const spec = {};
  for (const [name, rule] of Object.entries(definition.params)) {
    const raw = input[name];
    if (raw === undefined || raw === null || raw === '') {
      spec[name] = rule.default;
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || (rule.integer && !Number.isInteger(value))) {
      throw new JobError(`Parameter "${name}" must be ${rule.integer ? 'a whole number' : 'a number'}`, 'job_param_invalid');
    }
    if (value < rule.min || value > rule.max) {
      throw new JobError(`Parameter "${name}" must be between ${rule.min} and ${rule.max}`, 'job_param_invalid');
    }
    spec[name] = value;
  }
  return spec;
};

const toCamel = (row) => {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
};

const publicJob = (row) => {
  const job = toCamel(row);
  if (!job) return job;
  // The result carries anything the agent chose to report; keep the API shape
  // stable and let the client decide what to render.
  job.kindLabel = JOB_KINDS[job.kind] ? JOB_KINDS[job.kind].label : job.kind;
  job.spec = job.spec || {};
  return job;
};

const client = () => getSupabaseClient(true);

const staleCutoffIso = () => new Date(Date.now() - STALE_CLAIM_SECONDS * 1000).toISOString();

const wrap = (error) => {
  if (error instanceof JobError) return error;
  if (isMissingTable(error)) {
    return new JobError('The job queue is not available on this deployment', 'jobs_unavailable', 503);
  }
  return error;
};

const findByRental = async (rentalId) => {
  try {
    const { data, error } = await client()
      .from(TABLE)
      .select('*')
      .eq('rental_id', rentalId)
      .maybeSingle();
    if (error) throw error;
    return publicJob(data);
  } catch (error) {
    throw wrap(error);
  }
};

/**
 * Renter submits the work for a running session. The purpose of the rental
 * decides what is allowed, so a rendering session cannot ask for a training
 * job (and vice versa).
 */
const submit = async ({ rental, userId, kind, params }) => {
  if (!rental || String(rental.renterId) !== String(userId)) {
    throw new JobError('This session is not yours', 'forbidden', 403);
  }
  if (rental.status !== 'active') {
    throw new JobError('The session is not running', 'rental_not_active', 409);
  }
  const purpose = rental.purpose || null;
  if (!purpose) {
    throw new JobError('This session has no declared purpose', 'purpose_required');
  }
  const allowed = PURPOSE_KINDS[purpose] || [];
  if (!allowed.length) {
    throw new JobError(`No worker executor is installed for "${purpose}" sessions yet`, 'job_kind_unavailable', 501);
  }
  if (!allowed.includes(kind)) {
    throw new JobError(
      `A "${purpose}" session cannot run "${kind}". Allowed: ${allowed.join(', ')}`,
      'job_kind_not_allowed'
    );
  }

  const spec = normalizeSpec(kind, params);
  try {
    const { data, error } = await client()
      .from(TABLE)
      .insert([{ rental_id: rental.id, kind, spec, status: 'queued' }])
      .select()
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new JobError('A job is already queued for this session', 'job_exists', 409);
      }
      throw error;
    }
    return publicJob(data);
  } catch (error) {
    throw wrap(error);
  }
};

/** Active rentals on one device, with their queued job if any. */
const pendingForDevice = async ({ providerId, deviceId }) => {
  try {
    const db = client();
    const { data: listings, error: listingError } = await db
      .from('gpu_listings')
      .select('id')
      .eq('provider_id', providerId)
      .eq('device_id', deviceId);
    if (listingError) throw listingError;
    if (!listings || !listings.length) return [];

    const { data: rentals, error: rentalError } = await db
      .from('rentals')
      .select('id, listing_id, purpose, status')
      .in('listing_id', listings.map((l) => l.id))
      .eq('status', 'active');
    if (rentalError) throw rentalError;
    if (!rentals || !rentals.length) return [];

    const { data: jobs, error: jobError } = await db
      .from(TABLE)
      .select('*')
      .in('rental_id', rentals.map((r) => r.id))
      .eq('status', 'queued');
    if (jobError) throw jobError;

    // Work whose agent died mid-run goes back on the queue after the stale
    // window, otherwise a crash leaves a paid session with a job nobody can
    // finish and no way to submit another (one job per rental).
    const { data: abandoned, error: abandonedError } = await db
      .from(TABLE)
      .select('*')
      .in('rental_id', rentals.map((r) => r.id))
      .eq('status', 'running')
      .lt('updated_at', staleCutoffIso());
    if (abandonedError) throw abandonedError;

    const byRental = new Map();
    for (const row of [...(jobs || []), ...(abandoned || [])]) {
      byRental.set(row.rental_id, publicJob(row));
    }
    return [...byRental.values()];
  } catch (error) {
    throw wrap(error);
  }
};

/**
 * Atomically take a queued job. Returns null when someone else already took it
 * (that is a normal race, not an error) or when the session is no longer live.
 */
const claim = async ({ rental, job, deviceId }) => {
  if (!job) return null;
  if (rental.status !== 'active') return null;
  try {
    const now = new Date().toISOString();
    const { data, error } = await client()
      .from(TABLE)
      .update({
        status: 'running',
        claimed_at: now,
        started_at: now,
        updated_at: now
      })
      .eq('rental_id', job.rentalId)
      .eq('status', 'queued')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (data) {
      const claimed = publicJob(data);
      claimed.deviceId = deviceId;
      return claimed;
    }

    // The first agent may have crashed with the job in 'running'. Only a row that
    // has been quiet longer than any preset can run is taken over; the conditional
    // UPDATE keeps the takeover atomic (two agents cannot both win it).
    const { data: abandoned, error: abandonedError } = await client()
      .from(TABLE)
      .update({
        status: 'running',
        claimed_at: now,
        started_at: now,
        updated_at: now
      })
      .eq('rental_id', job.rentalId)
      .eq('status', 'running')
      .lt('updated_at', staleCutoffIso())
      .select()
      .maybeSingle();
    if (abandonedError) throw abandonedError;
    if (!abandoned) return null;

    const reclaimed = publicJob(abandoned);
    reclaimed.deviceId = deviceId;
    reclaimed.reclaimed = true;
    return reclaimed;
  } catch (error) {
    throw wrap(error);
  }
};

/** Append a progress line. Returns the job's current status so the agent can
 *  stop a job whose session was ended under it. */
const progress = async ({ rentalId, message, percent, telemetry }) => {
  try {
    const { data: job, error } = await client()
      .from(TABLE)
      .select('*')
      .eq('rental_id', rentalId)
      .maybeSingle();
    if (error) throw error;
    if (!job) throw new JobError('Job not found', 'not_found', 404);
    if (job.status !== 'running') {
      return { accepted: false, status: job.status };
    }

    // A rental can end while the GPU is still crunching. The session is the
    // contract, so the job is cancelled here and the agent is told to stop —
    // otherwise a provider keeps billing for work nobody ordered any more.
    const { data: rental, error: rentalError } = await client()
      .from('rentals')
      .select('status')
      .eq('id', rentalId)
      .maybeSingle();
    if (rentalError) throw rentalError;
    if (!rental || rental.status !== 'active') {
      const now = new Date().toISOString();
      const line = `[${now.slice(11, 19)}] session is no longer running — job cancelled\n`;
      await client()
        .from(TABLE)
        .update({
          status: 'cancelled',
          log: `${job.log || ''}${line}`.slice(-LOG_LIMIT),
          finished_at: now,
          updated_at: now
        })
        .eq('rental_id', rentalId)
        .eq('status', 'running');
      return { accepted: false, status: 'cancelled' };
    }
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `[${stamp}]${Number.isFinite(Number(percent)) ? ` ${Math.round(Number(percent))}%` : ''} ${String(message || '').slice(0, 500)}\n`;
    const log = `${job.log || ''}${line}`.slice(-LOG_LIMIT);
    const patch = { log, updated_at: new Date().toISOString() };
    if (Number.isFinite(Number(percent))) patch.progress = Math.max(0, Math.min(100, Math.round(Number(percent))));
    if (telemetry && typeof telemetry === 'object') patch.telemetry = telemetry;
    const { error: updateError } = await client().from(TABLE).update(patch).eq('rental_id', rentalId);
    if (updateError) throw updateError;
    return { accepted: true, status: 'running' };
  } catch (error) {
    throw wrap(error);
  }
};

const complete = async ({ rentalId, status, exitCode, result, log }) => {
  if (!['succeeded', 'failed', 'cancelled'].includes(status)) {
    throw new JobError('status must be succeeded, failed or cancelled', 'job_status_invalid');
  }
  const encoded = result === undefined ? null : JSON.stringify(result);
  if (encoded && encoded.length > RESULT_LIMIT) {
    throw new JobError('Job result is too large', 'job_result_too_large', 413);
  }
  try {
    const now = new Date().toISOString();
    const patch = {
      status,
      exit_code: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
      result: result === undefined ? null : result,
      finished_at: now,
      updated_at: now
    };
    if (log) patch.log = `${log}`.slice(-LOG_LIMIT);
    const { data, error } = await client()
      .from(TABLE)
      .update(patch)
      .eq('rental_id', rentalId)
      .eq('status', 'running')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (data) return publicJob(data);
    // Already terminal: answer with the stored row (idempotent retry).
    const existing = await findByRental(rentalId);
    if (!existing) throw new JobError('Job not found', 'not_found', 404);
    return existing;
  } catch (error) {
    throw wrap(error);
  }
};

const checksum = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

module.exports = {
  JobError,
  JOB_KINDS,
  PURPOSE_KINDS,
  LOG_LIMIT,
  RESULT_LIMIT,
  normalizeSpec,
  findByRental,
  submit,
  pendingForDevice,
  claim,
  progress,
  complete,
  checksum
};
