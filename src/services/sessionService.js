/**
 * Active-session inventory (P1-05) + Phase 5 session usage/SSH/wipe.
 */
const { getSupabaseClient } = require('../config/supabase');
const { revokeJti } = require('./revocation');
const catalog = require('./catalogService');
const { isMissingSchema } = catalog;

const TABLE = 'sessions';

const isMissingTable = (error) =>
  Boolean(error) && (error.code === '42P01' || /does not exist|Could not find the table/i.test(error.message || ''));

class SessionsUnavailable extends Error {
  constructor() { super('Active sessions are not available on this deployment (migration 011 not applied).'); this.code = 'sessions_unavailable'; }
}

const client = () => getSupabaseClient(true);

const describeRequest = (req) => {
  const userAgent = (req?.headers?.['user-agent'] || '').slice(0, 300) || null;
  const forwarded = (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.ip || null;
  return { userAgent, ipAddress: ip ? String(ip).slice(0, 60) : null };
};

const record = async ({ userId, jti, req }) => {
  if (!userId || !jti) return null;
  const { userAgent, ipAddress } = describeRequest(req);
  try {
    const { error } = await client().from(TABLE).insert({
      user_id: userId, jti, user_agent: userAgent, ip_address: ipAddress,
      last_seen_at: new Date().toISOString()
    });
    if (error) { if (!isMissingTable(error)) console.error('sessions.record failed:', error.message); return null; }
    return true;
  } catch (error) { console.error('sessions.record threw:', error.message || String(error)); return null; }
};

const touch = async (jti) => {
  if (!jti) return;
  try {
    const { error } = await client().from(TABLE).update({ last_seen_at: new Date().toISOString() }).eq('jti', jti).is('revoked_at', null);
    if (error && !isMissingTable(error)) console.error('sessions.touch failed:', error.message);
  } catch { /* ignore */ }
};

const rotate = async ({ userId, oldJti, newJti, req }) => {
  if (!newJti) return null;
  if (oldJti) {
    try { await client().from(TABLE).update({ revoked_at: new Date().toISOString(), revoked_reason: 'rotated' }).eq('jti', oldJti).is('revoked_at', null); }
    catch { /* best effort */ }
  }
  return record({ userId, jti: newJti, req });
};

const listActive = async (userId) => {
  const { data, error } = await client().from(TABLE).select('id, jti, user_agent, ip_address, created_at, last_seen_at').eq('user_id', userId).is('revoked_at', null).order('last_seen_at', { ascending: false });
  if (error) { if (isMissingTable(error)) throw new SessionsUnavailable(); throw new Error(`sessions.listActive failed: ${error.message}`); }
  return data || [];
};

const revokeOne = async ({ userId, sessionId }) => {
  const { data, error } = await client().from(TABLE).select('id, jti, revoked_at').eq('id', sessionId).eq('user_id', userId).maybeSingle();
  if (error) { if (isMissingTable(error)) throw new SessionsUnavailable(); throw new Error(`sessions.revokeOne lookup failed: ${error.message}`); }
  if (!data) return false;
  if (data.revoked_at) return true;
  await client().from(TABLE).update({ revoked_at: new Date().toISOString(), revoked_reason: 'user_revoked' }).eq('id', data.id);
  await revokeJti(data.jti, { userId });
  return true;
};

const revokeAllExcept = async ({ userId, keepJti }) => {
  const { data, error } = await client().from(TABLE).select('id, jti').eq('user_id', userId).is('revoked_at', null);
  if (error) { if (isMissingTable(error)) throw new SessionsUnavailable(); throw new Error(`sessions.revokeAllExcept failed: ${error.message}`); }
  const targets = (data || []).filter((row) => row.jti !== keepJti);
  for (const row of targets) {
    await client().from(TABLE).update({ revoked_at: new Date().toISOString(), revoked_reason: 'revoked_others' }).eq('id', row.id);
    await revokeJti(row.jti, { userId });
  }
  return targets.length;
};

const revokeByJti = async ({ jti }) => {
  if (!jti) return false;
  try {
    const { error } = await client().from(TABLE).update({ revoked_at: new Date().toISOString(), revoked_reason: 'logout' }).eq('jti', jti).is('revoked_at', null);
    if (error && !isMissingTable(error)) console.error('sessions.revokeByJti failed:', error.message);
    return true;
  } catch (error) { console.error('sessions.revokeByJti threw:', error.message || String(error)); return false; }
};

// ─── Phase 5: session usage / SSH / disk wipe ────────────────────────────────
class SessionError extends Error { constructor(m, code='session_error', status=400, extra={}) { super(m); this.name='SessionError'; this.code=code; this.status=status; this.extra=extra; } }
class SessionUnavailable extends SessionError { constructor() { super('Session features are not available on this deployment yet (migration 015 not applied).', 'session_unavailable', 503); this.name='SessionUnavailable'; } }

const p5FailOpen = (e) => { throw isMissingSchema(e) ? new SessionUnavailable() : e; };
const p5Camel = (row) => { if (!row) return row; const o={}; for (const [k,v] of Object.entries(row)) o[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())]=v; return o; };

const recordHeartbeat = async (rentalId, payload = {}) => {
  const row = { rental_id: rentalId, cpu_percent: payload.cpuPercent ?? null, gpu_percent: payload.gpuPercent ?? null,
    gpu_temp_c: payload.gpuTempC ?? null, ram_used_mb: payload.ramUsedMb ?? null, disk_used_gb: payload.diskUsedGb ?? null,
    network_rx_bytes: payload.networkRxBytes ?? null, network_tx_bytes: payload.networkTxBytes ?? null, idle_seconds: Number(payload.idleSeconds)||0 };
  try { const { data, error } = await client().from('session_heartbeats').insert(row).select().single();
    if (error) { p5FailOpen(error); return null; } return p5Camel(data); } catch (e) { p5FailOpen(e); }
};
const latestHeartbeat = async (rentalId) => {
  try { const { data, error } = await client().from('session_heartbeats').select('*').eq('rental_id', rentalId).order('recorded_at',{ascending:false}).limit(1).maybeSingle();
    if (error) { p5FailOpen(error); return null; } return data ? p5Camel(data) : null; } catch (e) { p5FailOpen(e); }
};
const recordEvent = async (rentalId, eventType, payload = {}) => {
  try { const { data, error } = await client().from('session_events').insert({ rental_id: rentalId, event_type: eventType, payload }).select().single();
    if (error) { p5FailOpen(error); return null; } return p5Camel(data); } catch (e) { p5FailOpen(e); }
};
const issueSshKey = async (rentalId, publicKey, expiresAt) => {
  const crypto = require('crypto');
  const fingerprint = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0,32);
  try { const { data, error } = await client().from('session_ssh_keys').insert({ rental_id: rentalId, public_key: publicKey, fingerprint, expires_at: expiresAt || new Date(Date.now()+24*60*60*1000).toISOString() }).select().single();
    if (error) { p5FailOpen(error); return null; } return p5Camel(data); } catch (e) { p5FailOpen(e); }
};
const revokeSshKeys = async (rentalId, reason = 'session_ended') => {
  try { const { data, error } = await client().from('session_ssh_keys').update({ revoked_at: new Date().toISOString(), revoked_reason: reason }).eq('rental_id', rentalId).is('revoked_at', null).select();
    if (error) { p5FailOpen(error); return []; } return (data||[]).map(p5Camel); } catch (e) { p5FailOpen(e); return []; }
};
const activeSshKeys = async (rentalId) => {
  try { const now = new Date().toISOString();
    const { data, error } = await client().from('session_ssh_keys').select('*').eq('rental_id', rentalId).is('revoked_at', null).gt('expires_at', now);
    if (error) { p5FailOpen(error); return []; } return (data||[]).map(p5Camel); } catch (e) { p5FailOpen(e); return []; }
};
const queueDiskWipe = async (rentalId, method = 'shred') => {
  try { const { data, error } = await client().from('session_disk_wipes').insert({ rental_id: rentalId, method, status: 'pending' }).select().single();
    if (error) { p5FailOpen(error); return null; } return p5Camel(data); } catch (e) { p5FailOpen(e); }
};
const markDiskWipe = async (id, status, error = null) => {
  const patch = { status };
  if (status === 'running') patch.started_at = new Date().toISOString();
  if (status === 'done' || status === 'failed') patch.finished_at = new Date().toISOString();
  if (error) patch.error = error;
  try { const { data, err } = await client().from('session_disk_wipes').update(patch).eq('id', id).select().single();
    if (err) { p5FailOpen(err); return null; } return p5Camel(data); } catch (e) { p5FailOpen(e); }
};
const idleRentals = async (idleMs = 5*60*1000) => {
  try { const cutoff = new Date(Date.now()-idleMs).toISOString();
    const { data, error } = await client().from('rentals').select('id, status').eq('status','active');
    if (error) { p5FailOpen(error); return []; }
    const out = [];
    for (const r of data || []) {
      const hb = await latestHeartbeat(r.id);
      if (!hb || new Date(hb.recordedAt) < new Date(cutoff)) out.push(r.id);
    }
    return out;
  } catch (e) { p5FailOpen(e); return []; }
};

module.exports = {
  // P1-05 active sessions
  record, touch, rotate, listActive, revokeOne, revokeAllExcept, revokeByJti, isMissingTable, SessionsUnavailable, TABLE,
  // Phase 5
  SessionError, SessionUnavailable,
  recordHeartbeat, latestHeartbeat, recordEvent,
  issueSshKey, revokeSshKeys, activeSshKeys,
  queueDiskWipe, markDiskWipe, idleRentals
};
