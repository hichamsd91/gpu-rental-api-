const { getSupabaseClient } = require('../config/supabase');
const catalog = require('./catalogService');
const { isMissingSchema } = catalog;

class OpsError extends Error { constructor(m, code='ops_error', status=400, extra={}) { super(m); this.name='OpsError'; this.code=code; this.status=status; this.extra=extra; } }
class OpsUnavailable extends OpsError { constructor() { super('Ops features are not available on this deployment yet (migration 018 not applied).', 'ops_unavailable', 503); this.name='OpsUnavailable'; } }

const client = () => getSupabaseClient(true);
const failOpen = (e) => { throw isMissingSchema(e) ? new OpsUnavailable() : e; };
const camel = (row) => { if (!row) return row; const o={}; for (const [k,v] of Object.entries(row)) o[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())]=v; return o; };

// ─── Support tickets ─────────────────────────────────────────────────────────
const createTicket = async ({ userId, subject, body, priority='normal' }) => {
  try {
    const { data, error } = await client().from('support_tickets').insert({ user_id: userId, subject, body, priority }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};
const listTickets = async ({ userId=null, status=null, limit=50 } = {}) => {
  try {
    let q = client().from('support_tickets').select('*').order('created_at', { ascending: false }).limit(limit);
    if (userId) q = q.eq('user_id', userId);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) { failOpen(error); return []; }
    return (data||[]).map(camel);
  } catch (e) { failOpen(e); return []; }
};
const getTicket = async (id) => {
  try {
    const { data, error } = await client().from('support_tickets').select('*').eq('id', id).maybeSingle();
    if (error) { failOpen(error); return null; }
    return data ? camel(data) : null;
  } catch (e) { failOpen(e); }
};
const updateTicket = async (id, patch) => {
  try {
    const { data, error } = await client().from('support_tickets').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};
const addTicketMessage = async ({ ticketId, authorId, body, isInternal=false }) => {
  try {
    const { data, error } = await client().from('ticket_messages').insert({ ticket_id: ticketId, author_id: authorId, body, is_internal: isInternal }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};
const listTicketMessages = async (ticketId, includeInternal=false) => {
  try {
    let q = client().from('ticket_messages').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true });
    if (!includeInternal) q = q.eq('is_internal', false);
    const { data, error } = await q;
    if (error) { failOpen(error); return []; }
    return (data||[]).map(camel);
  } catch (e) { failOpen(e); return []; }
};

// ─── Notifications ───────────────────────────────────────────────────────────
const createNotification = async ({ userId, type, title, body=null, link=null }) => {
  try {
    const { data, error } = await client().from('notifications').insert({ user_id: userId, type, title, body, link }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};
const listNotifications = async (userId, { unreadOnly=false, limit=50 } = {}) => {
  try {
    let q = client().from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
    if (unreadOnly) q = q.is('read_at', null);
    const { data, error } = await q;
    if (error) { failOpen(error); return []; }
    return (data||[]).map(camel);
  } catch (e) { failOpen(e); return []; }
};
const markNotificationRead = async (id, userId) => {
  try {
    const { data, error } = await client().from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};
const markAllNotificationsRead = async (userId) => {
  try {
    const { error } = await client().from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', userId).is('read_at', null);
    if (error) { failOpen(error); return false; }
    return true;
  } catch (e) { failOpen(e); return false; }
};

// ─── Admin audit ─────────────────────────────────────────────────────────────
const audit = async ({ adminId, action, targetType=null, targetId=null, details={} }) => {
  try {
    const { error } = await client().from('admin_audit_log').insert({ admin_id: adminId, action, target_type: targetType, target_id: targetId, details });
    if (error) { failOpen(error); return false; }
    return true;
  } catch (e) { failOpen(e); return false; }
};

module.exports = { OpsError, OpsUnavailable, createTicket, listTickets, getTicket, updateTicket, addTicketMessage, listTicketMessages, createNotification, listNotifications, markNotificationRead, markAllNotificationsRead, audit };
