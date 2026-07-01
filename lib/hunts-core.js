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

// Resolve the correct hunt key for a tenant. The 'bean' tenant ALWAYS gets the bare legacy
// key — this is load-bearing: Bean's OBS browser-source overlay is already live in production
// at a URL containing the literal string '__mod_hunt__' (src/pages/Overlay.js in the frontend
// repo is fully generic, keyed only by whatever :userId appears in the URL). That URL must
// never need to change, so tenantId === 'bean' (or falsy, back-compat) always resolves to the
// bare MOD_HUNT_ID/AFFILIATE_HUNT_ID string. Any OTHER tenant gets a namespaced key so multiple
// communities' mod hunts don't collide on one global object.
function modHuntKey(tenantId) {
  return (tenantId === 'bean' || !tenantId) ? MOD_HUNT_ID : `${MOD_HUNT_ID}:${tenantId}`;
}
function affiliateHuntKey(tenantId) {
  return (tenantId === 'bean' || !tenantId) ? AFFILIATE_HUNT_ID : `${AFFILIATE_HUNT_ID}:${tenantId}`;
}

function huntSummary(h) {
  return {
    userId: h.user?.id, username: h.user?.displayName, avatar: h.user?.avatar,
    huntType: h.huntType, isLive: h.isLive, startedAt: h.startedAt, archivedAt: h.archivedAt||null,
    bonusCount: (h.bonuses||[]).length,
    totalWon: (h.bonuses||[]).reduce((s,b)=>s+(b.win||0),0),
    pot: (h.equity||[]).reduce((s,e)=>s+(e.amount||0),0),
    // Include the equity list ONLY for archived hunts — needed for per-member all-time-payout
    // calculation on the equity cards. Live hunts omit it (bandwidth + don't expose equity publicly).
    equity: h.archivedAt
      ? (h.equity || []).map(e => ({ id: e.id, name: e.name, amount: e.amount, isRollWinner: !!e.isRollWinner, isMod: !!e.isMod }))
      : undefined,
    viewers: viewers[h.user?.id]||0,
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
function getPublicHunts(tenantId)   { return Object.values(hunts).filter(h=>h.isLive && inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId)).map(huntSummary); }
// Public Archived tab: only completed hunts (every bonus opened). Incomplete ended hunts are
// hidden here — admins still see them in the All tab, and the janitor eventually reaps them.
function getArchivedHunts(tenantId) { return archive.filter(h=>inTenant(h,tenantId) && huntCompleted(h)).map(huntSummary); }
// Admin All tab: every hunt — created, live, and archived. Union of the current hunts (created/
// live/ended) with archived snapshots whose hunt is no longer current, deduped by huntId.
function getAllHunts(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId));
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  return [...current, ...archivedOnly].map(huntSummary);
}
// Slot popularity aggregation for "Add Random Slots". Counts how many hunts featured each
// slot — once per hunt (calls/bonuses are deduped per hunt by persistence), so the count is
// "appeared in N hunts". Two signals: calls[] (what people CALLED) and bonuses[] (what GOT IN
// / actually played). Tenant-scoped; mirrors getAllHunts' current+archived dedup so a live hunt
// that's also archived isn't double-counted. Returns top 250 of each, sorted desc.
function getSlotCallCounts(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId));
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  const all = [...current, ...archivedOnly];
  const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const bump = (map, slot) => {
    const name = (slot||'').trim();
    const k = norm(name);
    if (!k) return;
    const e = map.get(k);
    if (e) e.count++; else map.set(k, { name, count: 1 });
  };
  const callMap = new Map(), bonusMap = new Map();
  for (const h of all) {
    if (Array.isArray(h.calls))   for (const c of h.calls)   bump(callMap, c.slot);
    if (Array.isArray(h.bonuses)) for (const b of h.bonuses) bump(bonusMap, b.slot);
  }
  const top = map => [...map.values()].sort((a,b)=>b.count-a.count).slice(0,250);
  return { calls: top(callMap), bonuses: top(bonusMap) };
}
// Got-In event log for the admin CSV export. Unlike getSlotCallCounts (which dedups to a
// per-hunt count), this returns EVERY individual got-in event — one row per bonus that carries
// a `ts` (stamped by the frontend when "Got In" is pressed). Tenant-scoped; mirrors the
// current+archived dedup so a live hunt that's also archived isn't emitted twice. Bonuses
// without a `ts` (pre-feature history) are skipped since they have no time. Sorted newest first.
function getGotInLog(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId));
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  const all = [...current, ...archivedOnly];
  const rows = [];
  for (const h of all) {
    if (!Array.isArray(h.bonuses)) continue;
    for (const b of h.bonuses) {
      if (!b || !b.ts) continue;
      rows.push({ ts: b.ts, slot: (b.slot||'').trim(), bet: Number(b.bet)||0 });
    }
  }
  rows.sort((a,b)=>b.ts-a.ts);
  return rows;
}
function emitHubUpdate(tenantId)    { persistHunts(); io.to('hub:'+(tenantId||'bean')).emit('hub:update', getPublicHunts(tenantId)); }
// Strip owner-only secrets + internal linkage before any public exposure: the share link
// (GET /api/share/:token) and the hunt:<id> socket broadcast, which includes non-editor
// viewers. Mirrors the GET /api/hunts/:userId non-editor branch so the two public views can't
// drift: PIN -> requiresPin boolean, drop the editor list + call-permission IDs, and drop each
// equity member's discordId. (Editors get invitedEditors from the REST invite endpoint, not the
// socket; callsPermissions and equity.discordId are never read client-side.)
function publicHuntView(h) {
  if (!h) return h;
  const { publicCallsPin, invitedEditors, callsPermissions, ...rest } = h;
  return {
    ...rest,
    requiresPin: !!publicCallsPin,
    equity: Array.isArray(h.equity) ? h.equity.map(({ discordId, ...e }) => e) : h.equity,
  };
}
function emitHuntUpdate(userId) { const h = hunts[userId]; if (h) { persistHunts(); io.to(`hunt:${userId}`).emit('hunt:update', publicHuntView(h)); } }

function uid() { return Math.random().toString(36).slice(2, 8); }
// Stamp a hunt's last-activity time so the stale-hunt janitor (cleanupStaleHunts) can measure idleness.
function touch(userId) { const h = hunts[userId]; if (h) h.updatedAt = new Date().toISOString(); }

module.exports = {
  initHuntsCore,
  MOD_HUNT_ID, AFFILIATE_HUNT_ID, modHuntKey, affiliateHuntKey,
  huntSummary, huntCompleted, tenantOf, inTenant,
  getPublicHunts, getArchivedHunts, getAllHunts, getSlotCallCounts, getGotInLog,
  emitHubUpdate, publicHuntView, emitHuntUpdate,
  uid, touch,
};
