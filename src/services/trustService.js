const { getSupabaseClient } = require('../config/supabase');
const catalog = require('./catalogService');
const { isMissingSchema } = catalog;

class TrustError extends Error { constructor(m, code='trust_error', status=400, extra={}) { super(m); this.name='TrustError'; this.code=code; this.status=status; this.extra=extra; } }
class TrustUnavailable extends TrustError { constructor() { super('Trust & safety features are not available on this deployment yet (migration 016 not applied).', 'trust_unavailable', 503); this.name='TrustUnavailable'; } }

const client = () => getSupabaseClient(true);
const failOpen = (e) => { throw isMissingSchema(e) ? new TrustUnavailable() : e; };
const camel = (row) => { if (!row) return row; const o={}; for (const [k,v] of Object.entries(row)) o[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())]=v; return o; };

const recordIdentitySignal = async (userId, signalType, signalValue) => {
  try {
    const { data, error } = await client().from('identity_links').upsert(
      { user_id: userId, signal_type: signalType, signal_value: signalValue },
      { onConflict: 'user_id,signal_type,signal_value' }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const findCluster = async (signalType, signalValue) => {
  try {
    const { data, error } = await client().from('identity_links').select('*').eq('signal_type', signalType).eq('signal_value', signalValue);
    if (error) { failOpen(error); return []; }
    return (data||[]).map(camel);
  } catch (e) { failOpen(e); return []; }
};

const isBanned = async (userId) => {
  try {
    const { data, error } = await client().from('account_bans').select('*').eq('user_id', userId).is('lifted_at', null);
    if (error) { failOpen(error); return false; }
    for (const b of data || []) {
      if (!b.expires_at || new Date(b.expires_at) > new Date()) return true;
    }
    return false;
  } catch (e) { failOpen(e); return false; }
};

const banAccount = async ({ userId, reason, scope='account', bannedBy=null, expiresAt=null }) => {
  try {
    const { data, error } = await client().from('account_bans').insert({
      user_id: userId, reason, scope, banned_by: bannedBy, expires_at: expiresAt
    }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const liftBan = async (banId, liftedBy) => {
  try {
    const { data, error } = await client().from('account_bans').update({ lifted_at: new Date().toISOString(), lifted_by: liftedBy }).eq('id', banId).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const recordFingerprint = async (fingerprint, userId, userAgent, ipAddress) => {
  try {
    const { data, error } = await client().from('device_fingerprints').upsert({
      fingerprint, user_id: userId, user_agent: userAgent, ip_address: ipAddress, last_seen_at: new Date().toISOString()
    }, { onConflict: 'fingerprint' }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const raiseAlert = async ({ userId=null, clusterId=null, alertType, severity='low', details={} }) => {
  try {
    const { data, error } = await client().from('fraud_alerts').insert({ user_id: userId, cluster_id: clusterId, alert_type: alertType, severity, details }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const listAlerts = async ({ status='open', limit=50 } = {}) => {
  try {
    const { data, error } = await client().from('fraud_alerts').select('*').eq('status', status).order('created_at', { ascending: false }).limit(limit);
    if (error) { failOpen(error); return []; }
    return (data||[]).map(camel);
  } catch (e) { failOpen(e); return []; }
};

const resolveAlert = async (id, resolvedBy, status='resolved') => {
  try {
    const { data, error } = await client().from('fraud_alerts').update({ status, resolved_at: new Date().toISOString(), resolved_by: resolvedBy }).eq('id', id).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

module.exports = { TrustError, TrustUnavailable, recordIdentitySignal, findCluster, isBanned, banAccount, liftBan, recordFingerprint, raiseAlert, listAlerts, resolveAlert };
