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
// Small artifacts ride inline in the poll response (the renter previews them
// without a second request). Anything larger is delivered through a short-lived
// signed link, so a 6-second poll never re-downloads megabytes of base64.
const INLINE_ARTIFACT_LIMIT = 96 * 1024;
const ARTIFACT_RAW_LIMIT = 4 * 1024 * 1024;
const ARTIFACT_LINK_TTL_SECONDS = 15 * 60;
const ARTIFACT_MIMES = new Set(['image/png', 'image/jpeg', 'application/zip', 'application/octet-stream']);
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

const artifactSecret = () => process.env.ARTIFACT_SECRET || process.env.JWT_SECRET || 'dev-artifact-secret';

const signArtifact = (rentalId, expiresAt) =>
  crypto.createHmac('sha256', artifactSecret())
    .update(`artifact:${rentalId}:${expiresAt}`)
    .digest('hex');

const artifactMime = (value) => (ARTIFACT_MIMES.has(String(value)) ? String(value) : 'application/octet-stream');

const safeFilename = (raw, mime) => {
  const fallback = `artifact${mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '.bin'}`;
  const name = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) : '';
  return name && name !== '.' && name !== '..' ? name : fallback;
};

/**
 * The agent's artifact is untrusted input. Hash the decoded bytes, compare them
 * with the checksum the agent reported (a mismatch is corrupt or tampered work),
 * then sign the verified digest with the server secret so the delivery record is
 * bound to this rental and cannot be swapped in a dispute.
 */
const verifyArtifact = (rentalId, result) => {
  if (!result || typeof result !== 'object') return result;
  const artifact = result.artifact;
  if (!artifact || typeof artifact !== 'object' || typeof artifact.base64 !== 'string') return result;
  const bytes = Buffer.from(artifact.base64, 'base64');
  if (!bytes.length) throw new JobError('The artifact is empty', 'job_artifact_empty', 422);
  if (bytes.length > ARTIFACT_RAW_LIMIT) {
    throw new JobError('The artifact is too large', 'job_artifact_too_large', 413);
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const short = digest.slice(0, 16);
  const reported = typeof artifact.checksum === 'string' ? artifact.checksum.toLowerCase() : null;
  if (reported && reported !== short) {
    throw new JobError('The artifact does not match the checksum the agent reported', 'job_artifact_checksum_mismatch', 422);
  }
  const signature = crypto.createHmac('sha256', artifactSecret())
    .update(`artifact:${rentalId}:${digest}:${bytes.length}`)
    .digest('hex');
  return {
    ...result,
    artifact: {
      ...artifact,
      mime: artifactMime(artifact.mime),
      filename: safeFilename(artifact.filename, artifactMime(artifact.mime)),
      bytes: bytes.length,
      checksum: short,
      verified: true,
      signature
    }
  };
};

/**
 * Renter-facing view: keep small artifacts inline for instant preview, add a
 * signed download link, and drop inline base64 once it stops being small.
 */
const forRenter = (job, origin) => {
  if (!job) return job;
  const artifact = job.result && job.result.artifact;
  if (!artifact || typeof artifact !== 'object' || typeof artifact.base64 !== 'string') return job;
  const expiresAt = Math.floor(Date.now() / 1000) + ARTIFACT_LINK_TTL_SECONDS;
  const sig = signArtifact(job.rentalId, expiresAt);
  const path = `/api/rentals/${job.rentalId}/job/artifact?exp=${expiresAt}&sig=${sig}`;
  const link = origin ? `${String(origin).replace(/\/+$/, '')}${path}` : path;
  const next = {
    ...artifact,
    url: link,
    expires_at: new Date(expiresAt * 1000).toISOString()
  };
  if (artifact.base64.length > INLINE_ARTIFACT_LIMIT) delete next.base64;
  return { ...job, result: { ...job.result, artifact: next } };
};

const artifactLinkValid = (rentalId, exp, sig) => {
  const expires = Number(exp);
  if (!rentalId || !Number.isInteger(expires) || typeof sig !== 'string' || !/^[a-f0-9]{64}$/i.test(sig)) {
    return false;
  }
  if (expires < Math.floor(Date.now() / 1000)) return false;
  const expected = signArtifact(rentalId, expires);
  const given = Buffer.from(sig, 'hex');
  const want = Buffer.from(expected, 'hex');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

const getArtifact = async (rentalId) => {
  const job = await findByRental(rentalId);
  const artifact = job && job.result && job.result.artifact;
  if (!artifact || typeof artifact.base64 !== 'string') return null;
  const mime = artifactMime(artifact.mime);
  return {
    mime,
    filename: safeFilename(artifact.filename, mime),
    bytes: Buffer.from(artifact.base64, 'base64')
  };
};

const complete = async ({ rentalId, status, exitCode, result, log }) => {
  if (!['succeeded', 'failed', 'cancelled'].includes(status)) {
    throw new JobError('status must be succeeded, failed or cancelled', 'job_status_invalid');
  }
  const hardened = verifyArtifact(rentalId, result);
  const encoded = hardened === undefined ? null : JSON.stringify(hardened);
  if (encoded && encoded.length > RESULT_LIMIT) {
    throw new JobError('Job result is too large', 'job_result_too_large', 413);
  }
  try {
    const now = new Date().toISOString();
    const patch = {
      status,
      exit_code: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
      result: hardened === undefined ? null : hardened,
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
  INLINE_ARTIFACT_LIMIT,
  ARTIFACT_LINK_TTL_SECONDS,
  normalizeSpec,
  findByRental,
  forRenter,
  getArtifact,
  artifactLinkValid,
  submit,
  pendingForDevice,
  claim,
  progress,
  complete,
  checksum
};
