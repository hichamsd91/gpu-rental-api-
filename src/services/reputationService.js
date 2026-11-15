const { getSupabaseClient } = require('../config/supabase');
const catalog = require('./catalogService');
const { isMissingSchema } = catalog;

class ReputationError extends Error { constructor(m, code='reputation_error', status=400, extra={}) { super(m); this.name='ReputationError'; this.code=code; this.status=status; this.extra=extra; } }
class ReputationUnavailable extends ReputationError { constructor() { super('Reputation features are not available on this deployment yet (migration 017 not applied).', 'reputation_unavailable', 503); this.name='ReputationUnavailable'; } }

const client = () => getSupabaseClient(true);
const failOpen = (e) => {
  if (isMissingSchema(e)) throw new ReputationUnavailable();
  // One review per rental per direction (unique index). A second attempt is a
  // client mistake, not a server fault — answer 409, never 500.
  if (e && e.code === '23505') {
    throw new ReputationError('You already reviewed this rental', 'already_reviewed', 409);
  }
  throw e;
};
const camel = (row) => { if (!row) return row; const o={}; for (const [k,v] of Object.entries(row)) o[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())]=v; return o; };

const createReview = async ({ rentalId, reviewerId, revieweeId, direction, rating, title, body }) => {
  try {
    const { data, error } = await client().from('reviews').insert({
      rental_id: rentalId, reviewer_id: reviewerId, reviewee_id: revieweeId,
      direction, rating, title, body, verified: true
    }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const reviewsForUser = async (userId, limit = 50) => {
  try {
    const { data, error } = await client().from('reviews').select('*').eq('reviewee_id', userId).order('created_at', { ascending: false }).limit(limit);
    if (error) { failOpen(error); return []; }
    return (data||[]).map(camel);
  } catch (e) { failOpen(e); return []; }
};

const averageRating = async (userId) => {
  const rows = await reviewsForUser(userId, 1000);
  if (!rows.length) return { count: 0, average: 0 };
  const sum = rows.reduce((s, r) => s + (r.rating || 0), 0);
  return { count: rows.length, average: Math.round((sum/rows.length)*10)/10 };
};

const openDispute = async ({ rentalId, openedBy, against, reason }) => {
  try {
    const { data, error } = await client().from('disputes').insert({ rental_id: rentalId, opened_by: openedBy, against, reason }).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

const listDisputes = async ({ status = 'open', limit = 50 } = {}) => {
  try {
    const { data, error } = await client().from('disputes').select('*').eq('status', status).order('created_at', { ascending: false }).limit(limit);
    if (error) { failOpen(error); return []; }
    return (data||[]).map(camel);
  } catch (e) { failOpen(e); return []; }
};

const resolveDispute = async (id, { status='resolved', resolution, refundAmountMinor=null, resolvedBy }) => {
  try {
    const { data, error } = await client().from('disputes').update({
      status, resolution, refund_amount_minor: refundAmountMinor,
      resolved_by: resolvedBy, resolved_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (error) { failOpen(error); return null; }
    return camel(data);
  } catch (e) { failOpen(e); }
};

module.exports = { ReputationError, ReputationUnavailable, createReview, reviewsForUser, averageRating, openDispute, listDisputes, resolveDispute };
