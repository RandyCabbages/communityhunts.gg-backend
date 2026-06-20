// Hunt-domain read/broadcast core: shaping hunts for the wire (huntSummary), the
// completed/tenant predicates, the public/archived/all list builders, the hub/hunt
// Socket.IO emit helpers, and the secret-stripping publicHuntView. Also owns the
// mod/affiliate fixed-hunt-key constants and the uid/touch helpers.
// Extracted from server.js (de-slop refactor, 2026-06-20). BEHAVIOR UNCHANGED.
//
// CONTRACT-SENSITIVE: publicHuntView strips publicCallsPin -> requiresPin before any
// hunt:update broadcast to the shared watch room. huntSummary's field set is the
// /api/hunts wire shape. Do not alter either without updating docs/baseline-endpoints.txt.
//
// DI: initHuntsCore({ hunts, archive, viewers, io, persistHunts }) — hunts/archive are the
// persistence-owned singletons (by reference, never reassigned); viewers is the SAME live
// viewer-count map the sockets module mutates (shared by reference).

let hunts = {};
let archive = [];
let viewers = {};
let io = null;
let persistHunts = () => {};

function initHuntsCore(deps) {
  hunts        = deps.hunts;
  archive      = deps.archive;
  viewers      = deps.viewers;
  io           = deps.io;
  persistHunts = deps.persistHunts || (() => {});
}

// Fixed hunt keys for the shared mod / affiliate hunts (not per-user).
const MOD_HUNT_ID = '__mod_hunt__';
const AFFILIATE_HUNT_ID = '__affiliate_hunt__';

function huntSummary(h) {
  return {
    userId: h.user.id, username: h.user.displayName, avatar: h.user.avatar,
    huntType: h.huntType, isLive: h.isLive, startedAt: h.startedAt, archivedAt: h.archivedAt||null,
    bonusCount: h.bonuses.length,
    totalWon: h.bonuses.reduce((s,b)=>s+b.win,0),
    pot: h.equity.reduce((s,e)=>s+e.amount,0),
    // Include the equity list ONLY for archived hunts — needed for per-member all-time-payout
    // calculation on the equity cards. Live hunts omit it (bandwidth + don't expose equity publicly).
    equity: h.archivedAt
      ? (h.equity || []).map(e => ({ id: e.id, name: e.name, amount: e.amount, isRollWinner: !!e.isRollWinner, isMod: !!e.isMod }))
      : undefined,
    viewers: viewers[h.user.id]||0,
    huntMode: h.huntMode||'creating',
    lockTop4: h.lockTop4 ?? false,
    rolledCount: (h.bonuses||[]).filter(b=>b.win>0).length,
    // "Completed" == every bonus has been opened (a win recorded). Mirrors the frontend's
    // allBonusesOpened. Drives the public Archived tab (completed-only) + the janitor.
    completed: huntCompleted(h),
    createdAt: h.createdAt || null, updatedAt: h.updatedAt || null,
  };
}
// A hunt is "completed" when it has bonuses and all of them have been opened (win recorded).
function huntCompleted(h) {
  return Array.isArray(h.bonuses) && h.bonuses.length > 0 && h.bonuses.every(b => +b.win > 0);
}
function tenantOf(h) { return h.tenantId || 'bean'; } // untagged hunts belong to Bean (back-compat)
function inTenant(h, tenantId) { return tenantOf(h) === (tenantId || 'bean'); }
function getPublicHunts(tenantId)   { return Object.values(hunts).filter(h=>h.isLive && inTenant(h,tenantId) && h.user?.id !== MOD_HUNT_ID && h.user?.id !== AFFILIATE_HUNT_ID).map(huntSummary); }
// Public Archived tab: only completed hunts (every bonus opened). Incomplete ended hunts are
// hidden here — admins still see them in the All tab, and the janitor eventually reaps them.
function getArchivedHunts(tenantId) { return archive.filter(h=>inTenant(h,tenantId) && huntCompleted(h)).map(huntSummary); }
// Admin All tab: every hunt — created, live, and archived. Union of the current hunts (created/
// live/ended) with archived snapshots whose hunt is no longer current, deduped by huntId.
function getAllHunts(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== MOD_HUNT_ID && h.user?.id !== AFFILIATE_HUNT_ID);
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  return [...current, ...archivedOnly].map(huntSummary);
}
function emitHubUpdate(tenantId)    { persistHunts(); io.to('hub:'+(tenantId||'bean')).emit('hub:update', getPublicHunts(tenantId)); }
// Strip owner-only secrets before broadcasting a hunt to the shared hunt:<id> watch room
// (which includes non-editor viewers). The PIN is replaced by a boolean the client can gate on.
function publicHuntView(h) {
  if (!h) return h;
  const { publicCallsPin, ...rest } = h;
  return { ...rest, requiresPin: !!publicCallsPin };
}
function emitHuntUpdate(userId) { const h = hunts[userId]; if (h) { persistHunts(); io.to(`hunt:${userId}`).emit('hunt:update', publicHuntView(h)); } }

function uid() { return Math.random().toString(36).slice(2, 8); }
// Stamp a hunt's last-activity time so the stale-hunt janitor (cleanupStaleHunts) can measure idleness.
function touch(userId) { const h = hunts[userId]; if (h) h.updatedAt = new Date().toISOString(); }

module.exports = {
  initHuntsCore,
  MOD_HUNT_ID, AFFILIATE_HUNT_ID,
  huntSummary, huntCompleted, tenantOf, inTenant,
  getPublicHunts, getArchivedHunts, getAllHunts,
  emitHubUpdate, publicHuntView, emitHuntUpdate,
  uid, touch,
};
