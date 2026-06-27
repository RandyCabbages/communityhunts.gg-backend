const fs = require('fs');
const path = require('path');

const HUNTS_FILE   = path.join(__dirname, '..', 'hunts_data.json');
const ARCHIVE_FILE = path.join(__dirname, '..', 'hunts_archive.json');
const SHARETOKENS_FILE = path.join(__dirname, '..', 'share_tokens.json');

// Shared mutable singletons — owned here, imported by reference elsewhere. Never reassign.
const hunts   = {};
const archive = []; // completed hunts, newest first
const shareTokens = {}; // { [token]: ownerKey } — stable per-streamer share links, survives hunt resets

let pgPool = null;
let normalizeSlot = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let huntsTableReady = Promise.resolve();

async function initPersistence(deps) {
  pgPool = deps.pgPool;
  if (deps.normalizeSlot) normalizeSlot = deps.normalizeSlot;
  // Initialize Postgres tables for hunts and archive
  if (pgPool) {
    huntsTableReady = pgPool.query(`
      CREATE TABLE IF NOT EXISTS hunts_kv (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      )
    `).then(() => console.log('[persist] Postgres hunts_kv table ready'))
      .catch(e => { console.error('[persist] hunts_kv init failed:', e.message); });
  }
  await loadPersistedState();
}

// Load persisted hunts on startup — try Postgres first, fall back to file
async function loadPersistedState() {
  let loadedFromPg = false;
  if (pgPool) {
    try {
      await huntsTableReady;
      const huntsRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='hunts'");
      if (huntsRow.rows[0]) {
        Object.assign(hunts, huntsRow.rows[0].value || {});
        loadedFromPg = true;
      }
      const archiveRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='archive'");
      if (archiveRow.rows[0]) {
        archive.push(...(archiveRow.rows[0].value || []));
      }
      const tokensRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='shareTokens'");
      if (tokensRow.rows[0]) Object.assign(shareTokens, tokensRow.rows[0].value || {});
      if (loadedFromPg) console.log(`[persist] Loaded ${Object.keys(hunts).length} hunts and ${archive.length} archived from Postgres`);
    } catch(e) { console.error('[persist] PG load failed:', e.message); }
  }
  // Fallback: load from file if Postgres was empty/unavailable
  if (!loadedFromPg) {
    try {
      if (fs.existsSync(HUNTS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(HUNTS_FILE, 'utf8'));
        Object.assign(hunts, saved);
        console.log(`[persist] Loaded ${Object.keys(hunts).length} hunts from file`);
      }
    } catch(e) { console.error('[persist] File load failed:', e.message); }
    try {
      if (fs.existsSync(ARCHIVE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
        archive.push(...saved);
        console.log(`[persist] Loaded ${archive.length} archived hunts from file`);
      }
    } catch(e) { console.error('[persist] Archive file load failed:', e.message); }
    try {
      if (fs.existsSync(SHARETOKENS_FILE)) {
        Object.assign(shareTokens, JSON.parse(fs.readFileSync(SHARETOKENS_FILE, 'utf8')));
        console.log(`[persist] Loaded ${Object.keys(shareTokens).length} share tokens from file`);
      }
    } catch(e) { console.error('[persist] Share tokens file load failed:', e.message); }
  }

  // Dedup calls one-time on load (cleanup from before normalization was added)
  let totalRemoved = 0;
  for (const id in hunts) {
    const h = hunts[id];
    if (!h) continue;
    // Backfill activity stamps so the stale-hunt janitor has a baseline. Missing == treat as
    // active "now" so pre-existing hunts get a fresh 36h grace instead of being instantly reaped.
    // (Ended hunts are judged by archivedAt, not updatedAt, so this only grants grace to
    // created/live hunts.)
    const nowIso = new Date().toISOString();
    if (!h.createdAt) h.createdAt = h.startedAt || nowIso;
    if (!h.updatedAt) h.updatedAt = nowIso;
    if (!Array.isArray(h.bonuses)) h.bonuses = [];
    if (!Array.isArray(h.equity))  h.equity  = [];
    if (!Array.isArray(h.calls))   h.calls   = [];
    if (h?.calls?.length) {
      const seen = new Set();
      const before = h.calls.length;
      h.calls = h.calls.filter(c => {
        const key = (c.slot || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      totalRemoved += before - h.calls.length;
    }
  }
  if (totalRemoved > 0) console.log(`[persist] Removed ${totalRemoved} duplicate calls on startup`);

  // One-time archive cleanup: collapse duplicate snapshots created before the upsert fix.
  // Same user + same start time + same bonus count + same total won == one hunt that was
  // ended repeatedly. Keep the newest snapshot of each; preserve newest-first ordering.
  const archiveSig = h => [
    h.user?.id,
    h.startedAt || '',
    Array.isArray(h.bonuses) ? h.bonuses.length : 0,
    Array.isArray(h.bonuses) ? h.bonuses.reduce((s, b) => s + (+b.win || 0), 0) : 0,
  ].join('|');
  const newestBySig = new Map();
  for (const h of archive) {
    const k = archiveSig(h);
    const prev = newestBySig.get(k);
    if (!prev || new Date(h.archivedAt || 0) > new Date(prev.archivedAt || 0)) newestBySig.set(k, h);
  }
  if (newestBySig.size < archive.length) {
    const removedDupes = archive.length - newestBySig.size;
    const deduped = [...newestBySig.values()].sort((a, b) => new Date(b.archivedAt || 0) - new Date(a.archivedAt || 0));
    archive.length = 0;
    archive.push(...deduped);
    persistArchive();
    console.log(`[persist] Collapsed ${removedDupes} duplicate archived hunt(s) on startup, ${archive.length} remain`);
  }
}

function persistHunts() {
  // Bulletproof: dedupe call arrays before persisting. Keeps first occurrence of each slot.
  for (const id in hunts) {
    const h = hunts[id];
    if (h?.calls?.length) {
      const seen = new Set();
      h.calls = h.calls.filter(c => {
        const key = normalizeSlot(c.slot);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  // Write to Postgres (durable across redeploys) AND file (local-dev fallback)
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('hunts',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(hunts)]
    ).catch(e => console.error('[persist] PG save hunts failed:', e.message));
  }
  try { fs.writeFileSync(HUNTS_FILE, JSON.stringify(hunts), 'utf8'); }
  catch(e) { /* file write may fail on ephemeral disk; that's OK if PG works */ }
}
function persistArchive() {
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('archive',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(archive)]
    ).catch(e => console.error('[persist] PG save archive failed:', e.message));
  }
  try { fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive), 'utf8'); }
  catch(e) { /* file write may fail on ephemeral disk */ }
}
function persistShareTokens() {
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('shareTokens',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(shareTokens)]
    ).catch(e => console.error('[persist] PG save shareTokens failed:', e.message));
  }
  try { fs.writeFileSync(SHARETOKENS_FILE, JSON.stringify(shareTokens), 'utf8'); }
  catch(e) { /* ephemeral disk; OK if PG works */ }
}
// Reverse lookup: the existing token for an owner, or null. Owner keys are unique values.
function tokenForOwner(ownerKey) {
  for (const t in shareTokens) if (shareTokens[t] === ownerKey) return t;
  return null;
}
// Identity of a single hunt instance, used to keep the archive free of duplicates.
// huntId is the stable key (assigned at start/reset, preserved across go-live/end/reopen);
// startedAt is a fallback for legacy snapshots archived before huntId existed.
function sameHuntInstance(a, b) {
  if (a.huntId && b.huntId) return a.huntId === b.huntId;
  return a.user?.id === b.user?.id && a.startedAt === b.startedAt;
}
function archiveHunt(hunt) {
  if (!hunt || !hunt.user) return;
  // Don't archive empty hunts — no bonuses means there's nothing to analyze,
  // and it keeps the archive/history from filling up with blank entries.
  if (!Array.isArray(hunt.bonuses) || hunt.bonuses.length === 0) return;
  const snap = { ...hunt, archivedAt: hunt.archivedAt || new Date().toISOString() };
  // Upsert, never append blindly: one entry per hunt instance. Re-ending the same hunt
  // refreshes its existing snapshot in place instead of stacking duplicate copies.
  const idx = archive.findIndex(h => sameHuntInstance(h, snap));
  if (idx !== -1) {
    archive[idx] = snap;
  } else {
    archive.unshift(snap);
    if (archive.length > 100) archive.splice(100);
  }
  persistArchive();
}
// Remove a hunt's snapshot from the archive — used when reopening a hunt ended by mistake,
// so history doesn't keep a copy of a hunt that's running again.
function unarchiveHunt(hunt) {
  if (!hunt) return;
  const idx = archive.findIndex(h => sameHuntInstance(h, hunt));
  if (idx !== -1) { archive.splice(idx, 1); persistArchive(); }
}

module.exports = { hunts, archive, shareTokens, initPersistence, persistHunts, persistArchive, persistShareTokens, tokenForOwner, archiveHunt, unarchiveHunt };
