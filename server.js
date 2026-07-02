const express         = require('express');
const session         = require('express-session');
const passport        = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors            = require('cors');
const http            = require('http');
const { Server }      = require('socket.io');
const fs              = require('fs');
const path            = require('path');

const app    = express();
const server = http.createServer(app);

const PORT         = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Support comma-separated list of allowed origins (e.g. for domain migrations)
const ALLOWED_ORIGINS = [
  ...new Set([
    FRONTEND_URL,
    'https://communityhunts.gg',
    'https://www.communityhunts.gg',
    ...(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  ])
];
function corsOrigin(origin, callback) {
  if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
  // Browser-extension requests (the CommunityHunts Chrome extension) send
  // Origin: chrome-extension://<id>. Allow the scheme — the extension's mutating
  // calls are authenticated by HMAC Bearer token, not by origin/cookies, and the
  // id is unstable for unpacked installs so we can't hardcode it. GET polls send
  // no Origin (allowed above); only PUT/POST saves send it, which is why saves 500'd.
  if (/^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin)) return callback(null, true);
  callback(new Error('Not allowed by CORS'));
}

const io = new Server(server, {
  cors: { origin: corsOrigin, credentials: true }
});
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[security] SESSION_SECRET is not set — using a random per-boot secret. Set SESSION_SECRET in the environment so sessions/tokens survive restarts and cannot be forged with a known default.');
  return require('crypto').randomBytes(48).toString('hex');
})();
// Set() dedups so a repeated entry in the Railway var (e.g. an ID appended twice)
// doesn't render the same admin twice in the platform-admins list.
const ADMIN_IDS      = [...new Set((process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean))];
const VIP_IDS        = [...new Set((process.env.VIP_IDS || '').split(',').map(s=>s.trim()).filter(Boolean))];
// Ticket env config (TICKET_EMAILS / RESEND_API_KEY / TICKET_FROM) moved to routes/misc.routes.js.
const DISCORD_GUILD_ID          = (process.env.DISCORD_GUILD_ID || '').trim();
const DISCORD_AFFILIATE_ROLE_ID = (process.env.DISCORD_AFFILIATE_ROLE_ID || '').trim();
const DISCORD_VIP_ROLE_ID       = (process.env.DISCORD_VIP_ROLE_ID || '').trim();
const DISCORD_MOD_ROLE_ID       = (process.env.DISCORD_MOD_ROLE_ID || '').trim();

// Fetches a user's roles in the configured guild using their OAuth access token
// (guilds.members.read scope). Called at login time; results cached in session.
async function fetchGuildRoles(oauthAccessToken) {
  if (!DISCORD_GUILD_ID || !oauthAccessToken) return { isAffiliate: false, isDiscordVip: false, isDiscordMod: false };
  try {
    const res = await fetch(`https://discord.com/api/v10/users/@me/guilds/${DISCORD_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${oauthAccessToken}` }
    });
    if (!res.ok) return { isAffiliate: false, isDiscordVip: false, isDiscordMod: false };
    const member = await res.json();
    const memberRoles = member.roles || [];
    return {
      isAffiliate:  !!(DISCORD_AFFILIATE_ROLE_ID && memberRoles.includes(DISCORD_AFFILIATE_ROLE_ID)),
      isDiscordVip: !!(DISCORD_VIP_ROLE_ID       && memberRoles.includes(DISCORD_VIP_ROLE_ID)),
      isDiscordMod: !!(DISCORD_MOD_ROLE_ID        && memberRoles.includes(DISCORD_MOD_ROLE_ID)),
    };
  } catch (e) {
    console.error('[discord] guild role fetch failed:', e.message);
    return { isAffiliate: false, isDiscordVip: false, isDiscordMod: false };
  }
}

// Normalize slot name for dedup: strip punctuation, collapse whitespace, lowercase
function normalizeSlot(name) { return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Auth + gating logic lives in lib/auth.js (ID-based admin/VIP, HMAC token fallback, hunt-
// permission checks, tenant resolution, gate middlewares). auth.initAuth(...) is called below
// once the lib deps (tenants/admins/hunts/settings) exist — the functions only run at request
// time, so the deferred init is safe. Re-bound into this scope so the inline routes that still
// reference these names keep working until they move into their own routers.
const auth = require('./lib/auth');
const {
  nameOf, isAdmin, isPlatformAdmin, isVipHost,
  signToken, verifyToken,
  canEditHunt, isEquityMember,
  requireAuth, reqIsAdmin, reqIsVipHost, requireAdmin, requirePlatformAdmin,
  reqIsMod, requireMod,
  resolveTenant,
} = auth;

// ── Middleware ─────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '256kb' }));

// Postgres pool — shared by session store and user_settings
const { Pool } = require('pg');
let pgPool = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  console.log('[pg] Pool created');
} else {
  console.log('[pg] No DATABASE_URL — sessions and settings will be in-memory only (will reset on redeploy)');
}

// Session config — Postgres-backed if pool is available, otherwise in-memory
const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // slide expiry forward on every request — was a hard 7-day cutoff from login, logging out anyone who didn't visit weekly
  cookie: { secure: true, sameSite: 'none', maxAge: 30 * 24 * 60 * 60 * 1000 }
};
if (pgPool) {
  const pgSession = require('connect-pg-simple')(session);
  sessionConfig.store = new pgSession({
    pool: pgPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  });
  console.log('[session] Using Postgres session store (persists across redeploys)');
} else {
  console.log('[session] Using in-memory session store (will reset on redeploy)');
}
app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

// Token-based auth fallback (Bearer) — for browsers that block third-party cookies. Logic in lib/auth.js.
app.use(auth.bearerFallback);

// Mounted globally so /auth/me also gets tenant context for the isAdmin/isVipHost flags it returns.
app.use(resolveTenant);

// ── Passport ───────────────────────────────────────────────────────
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || `${FRONTEND_URL}/auth/discord/callback`,
  scope: ['identify', 'guilds.members.read']
}, async (access, refresh, profile, done) => {
  const guildRoles = await fetchGuildRoles(access);
  done(null, {
    id: profile.id,
    username: profile.username,
    displayName: profile.global_name || profile.username,
    avatar: profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator||0)%5}.png`,
    isAffiliate: guildRoles.isAffiliate,
    isDiscordVip: guildRoles.isDiscordVip,
    isDiscordMod: guildRoles.isDiscordMod,
  });
}));
passport.serializeUser((u,d) => d(null,u));
passport.deserializeUser((u,d) => d(null,u));


// ── State ──────────────────────────────────────────────────────────
const viewers = {};

// Persistence layer (hunt/archive state + Postgres hunts_kv) lives in lib/persistence.js.
// hunts/archive are shared singletons owned there — imported by reference, never reassigned.
const persistence = require('./lib/persistence');
const { hunts, archive, shareTokens, persistHunts, persistArchive, persistShareTokens, tokenForOwner, archiveHunt, unarchiveHunt } = persistence;

// User settings + known-users (Postgres-backed, file fallback). Owns user_settings/known_users
// tables, the name-lookup helpers, and the startup backfill. Needs hunts (by reference) for backfill.
const settings = require('./lib/settings');
settings.initSettings({ pgPool, hunts });
const { recordKnownUser } = settings;  // called from the auth callback / Bearer middleware

persistence.initPersistence({ pgPool, normalizeSlot })
  .then(() => settings.startupBackfill())
  .catch(e => console.error('[persist] init error:', e.message));

// Multi-tenancy config (tenants + roles). Gated by MULTI_TENANT; defaults to Bean.
const tenants = require('./lib/tenants');
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
tenants.initTenants({ pgPool }).catch(e => console.error('[tenants] init error:', e.message));
const admins = require('./lib/admins');
admins.initAdmins({ pgPool }).catch(e => console.error('[admins] init error:', e.message));

// Community memberships (which communities a user belongs to). One-time backfill attributes
// every previously-known user to Bean; new users auto-join the slug they sign in through.
const memberships = require('./lib/memberships');
memberships.initMemberships({ pgPool })
  .then(() => memberships.backfillExistingUsersToBean(tenants.BEAN_TENANT.id))
  .catch(e => console.error('[memberships] init error:', e.message));

// Inject auth deps now that every collaborator exists. The gate functions were already
// re-bound above; they only run at request time, so wiring their deps here is in time.
auth.initAuth({ ADMIN_IDS, VIP_IDS, SESSION_SECRET, MULTI_TENANT, tenants, admins, hunts, recordKnownUser });

// Hunt-domain read/broadcast core (huntSummary, list builders, publicHuntView secret-strip,
// hub/hunt emit helpers, mod/affiliate hunt-key constants, uid/touch). viewers is shared by
// reference with the sockets module so live viewer counts stay coherent. Re-bound into scope
// so the still-inline hunt routes keep working until they move into their own routers.
const huntsCore = require('./lib/hunts-core');
huntsCore.initHuntsCore({ hunts, archive, viewers, io, persistHunts });
const {
  MOD_HUNT_ID, AFFILIATE_HUNT_ID, modHuntKey, affiliateHuntKey,
  huntSummary, huntCompleted, tenantOf, inTenant,
  getPublicHunts, getArchivedHunts, getAllHunts, getSlotCallCounts, getGotInLog,
  emitHubUpdate, publicHuntView, emitHuntUpdate,
  uid, touch,
} = huntsCore;

// Auth + community-membership routes (routes/auth.routes.js). Mounted here, after the lib deps
// exist. Passport strategy is configured above; resolveTenant (global) already set req.tenant.
app.use(require('./routes/auth.routes')({
  passport, FRONTEND_URL, requireAuth,
  reqIsAdmin, reqIsVipHost, reqIsMod, isPlatformAdmin, signToken,
  recordKnownUser, memberships, tenants, pgPool,
}));


// Reject malformed / oversized hunt payloads (memory + DoS protection).
const MAX_BONUSES = 1000, MAX_EQUITY = 300, MAX_CALLS = 1000;
function rejectBadHuntInput(req, res) {
  const { bonuses, equity, calls } = req.body || {};
  if (bonuses !== undefined && (!Array.isArray(bonuses) || bonuses.length > MAX_BONUSES)) { res.status(400).json({error:'Invalid bonuses payload'}); return true; }
  if (equity  !== undefined && (!Array.isArray(equity)  || equity.length  > MAX_EQUITY))  { res.status(400).json({error:'Invalid equity payload'});  return true; }
  if (calls   !== undefined && (!Array.isArray(calls)   || calls.length   > MAX_CALLS))   { res.status(400).json({error:'Invalid calls payload'});   return true; }
  const { currency } = req.body || {};
  if (currency !== undefined && !['USD','CAD','ARS'].includes(currency)) { res.status(400).json({error:'Invalid currency'}); return true; }
  const { publicCalls, publicCallsPin } = req.body || {};
  if (publicCalls    !== undefined && typeof publicCalls !== 'boolean')                        { res.status(400).json({error:'Invalid publicCalls payload'}); return true; }
  if (publicCallsPin !== undefined && publicCallsPin !== null &&
      (typeof publicCallsPin !== 'string' || publicCallsPin.length > 32))                      { res.status(400).json({error:'Invalid publicCallsPin payload'}); return true; }
  return false;
}

// Public-hunt + my-hunt routes (routes/hunts.routes.js). Declaration order inside the router is
// load-bearing: /api/hunts/archived before /api/hunts/:userId.
app.use(require('./routes/hunts.routes')({
  requireAuth, canEditHunt, isEquityMember, reqIsVipHost, reqIsMod,
  hunts, archive, getPublicHunts, getArchivedHunts,
  emitHubUpdate, emitHuntUpdate, publicHuntView, uid, touch,
  persistHunts, archiveHunt, unarchiveHunt, io, rejectBadHuntInput,
}));

// Mod hunt + Affiliate hunt — two fixed-key shared hunts (routes/mod-hunt.routes.js).
app.use(require('./routes/mod-hunt.routes')({
  hunts, archive, io, persistHunts, archiveHunt,
  requireMod, modHuntKey, affiliateHuntKey, tenants,
  uid, touch, publicHuntView, rejectBadHuntInput,
}));

// Tenant-mod management (routes/mods.routes.js). Owner-only add/remove; view is requireAdmin
// (covers tenant admins + mods, post reqIsAdmin fold-in).
app.use(require('./routes/mods.routes')({
  requireAuth, requireAdmin, requirePlatformAdmin, tenants, pgPool,
}));

// OverDrop — mod-controlled stream overlay (routes/overdrop.routes.js). State + socket
// broadcasts live in lib/overdrop.js; sockets stay read-only (see that file's security note).
const overdrop = require('./lib/overdrop');
overdrop.initOverdrop(io);
app.use(require('./routes/overdrop.routes')({ requireMod, overdrop }));

// Slot-call + call-permission routes (routes/calls.routes.js). Owns huntCallRequests state.
app.use(require('./routes/calls.routes')({
  hunts, io, persistHunts,
  requireAuth, canEditHunt, isEquityMember, reqIsAdmin,
  normalizeSlot, nameOf, publicHuntView, emitHubUpdate, uid, rejectBadHuntInput,
}));

// Share-link routes (routes/share.routes.js): token mint + public resolve.
app.use(require('./routes/share.routes')({
  requireAuth, canEditHunt, hunts, archive, publicHuntView, uid,
  shareTokens, tokenForOwner, persistShareTokens,
}));

// ── Stale-hunt janitor ─────────────────────────────────────────────
// Reap abandoned hunts after 36h of inactivity so the directory stays honest and storage bounded.
// Idle is measured from updatedAt (created/live) or archivedAt (ended). Rules:
//   • created, never went live     → delete
//   • live, abandoned, has bonuses → auto-end + archive (kept as history)
//   • live, abandoned, 0 bonuses   → delete (nothing worth keeping)
//   • ended, incomplete            → delete (+ drop its archive snapshot)
//   • ended/archived, completed    → keep
const STALE_MS = 36 * 60 * 60 * 1000;
function cleanupStaleHunts() {
  const now = Date.now();
  const idleMs = ts => now - new Date(ts || 0).getTime();
  const affectedTenants = new Set();
  const touchedRooms = [];
  let huntsChanged = false, archiveChanged = false, deleted = 0, archivedN = 0;

  // Object.entries snapshots the keys, so deleting during the loop is safe.
  for (const [id, h] of Object.entries(hunts)) {
    if (!h || !h.user) continue;
    if (h.isLive) {
      if (idleMs(h.updatedAt || h.startedAt) < STALE_MS) continue;
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (Array.isArray(h.bonuses) && h.bonuses.length > 0) {
        if (!h.archivedAt) h.archivedAt = new Date().toISOString();
        archiveHunt(h); archivedN++;          // keep it as history
      } else {
        delete hunts[id]; deleted++;          // empty — nothing to archive
      }
      affectedTenants.add(tenantOf(h)); touchedRooms.push(id); huntsChanged = true;
    } else if (h.archivedAt) {
      if (huntCompleted(h) || idleMs(h.archivedAt) < STALE_MS) continue;
      unarchiveHunt(h); delete hunts[id]; deleted++;   // incomplete + idle → drop from both maps
      affectedTenants.add(tenantOf(h)); huntsChanged = true;
    } else {
      if (idleMs(h.updatedAt || h.createdAt) < STALE_MS) continue;
      delete hunts[id]; deleted++;            // created but never run
      affectedTenants.add(tenantOf(h)); huntsChanged = true;
    }
  }

  // Orphan archive snapshots (hunt no longer current): drop incomplete + idle ones.
  for (let i = archive.length - 1; i >= 0; i--) {
    const h = archive[i];
    if (huntCompleted(h) || idleMs(h.archivedAt) < STALE_MS) continue;
    archive.splice(i, 1); deleted++;
    affectedTenants.add(tenantOf(h)); archiveChanged = true;
  }

  if (huntsChanged) persistHunts();
  if (archiveChanged) persistArchive();
  affectedTenants.forEach(t => emitHubUpdate(t));
  touchedRooms.forEach(id => io.to(`hunt:${id}`).emit('hunt:update', publicHuntView(hunts[id]) || { isLive:false, archivedAt:new Date().toISOString() }));
  if (deleted || archivedN) console.log(`[janitor] swept stale hunts — ${deleted} deleted, ${archivedN} auto-archived`);
  return { deleted, archived: archivedN };
}
// Run once after persistence settles, then hourly.
setTimeout(cleanupStaleHunts, 30 * 1000);
setInterval(cleanupStaleHunts, 60 * 60 * 1000);

// Admin routes (routes/admin.routes.js). The janitor above stays here (composition-root
// background task); the manual /api/admin/hunts/cleanup trigger calls the injected cleanupStaleHunts.
app.use(require('./routes/admin.routes')({
  requireAuth, requireAdmin, requirePlatformAdmin,
  getAllHunts, getArchivedHunts, getGotInLog,
  pgPool, admins, tenants, ADMIN_IDS,
  hunts, archive, archiveHunt, unarchiveHunt, persistArchive,
  emitHubUpdate, publicHuntView, io, uid, cleanupStaleHunts,
}));

// ── User Settings + known-users + admin user management ────────────
// Helpers + tables live in lib/settings.js; routes in routes/settings.routes.js
// (mounted below near the slots router). recordKnownUser/getSettings/saveSettings
// are destructured from the settings module at init.

// /api/tickets moved to routes/misc.routes.js (mounted below near the slots router).

// ── External integrations (Twitch live, leaderboard, Discord) ──────
// Logic lives in lib/integrations.js; routes in routes/integrations.routes.js.
const integrations = require('./lib/integrations');
// Poll each active tenant's Twitch channel. Runs after tenants load.
function startPolling() { integrations.startTenantPolling(io, tenants.getAllTenants()); }
// initTenants() is async; give it a beat, then start polling (Bean is in cache immediately anyway).
setTimeout(startPolling, 3000);

app.use(require('./routes/integrations.routes')({
  integrations, tenants, memberships, hunts, normalizeSlot, requireAuth,
}));


// ── Slot Autocomplete + image proxy ───────────────────────────────
// Logic + caches live in lib/slots.js (self-contained: no hunts/io/auth coupling).
// Routes are mounted via routes/slots.routes.js. Pre-fetch the slot list on startup.
const slots = require('./lib/slots');
slots.prefetchSlots();
app.use(require('./routes/slots.routes')({ slots, getSlotCallCounts }));

// Checks Rainbet for newly-released slots every 10 min in-process (replaces the
// GitHub Actions cron, which was firing every 1.5-5hrs instead of every 30 min).
require('./lib/rainbetSlotSync').startRainbetSlotSync(slots);

// Misc leaf routes: /api/bangers (reads hunts+archive), /api/tickets, /api/health.
app.use(require('./routes/misc.routes')({ hunts, archive }));

// User settings + admin user-management routes (helpers in lib/settings.js).
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, requireAuth, requireAdmin,
}));


// Global error handler. Without one, an uncaught throw in any route returns Express's default
// HTML "Internal Server Error" with the stack thrown away (which is what hid the extension CORS
// 500). Log the full stack server-side (Railway logs) and return a generic JSON error — no stack
// leak in the response body.
app.use((err, req, res, next) => {
  console.error(`[ERR] ${req.method} ${req.originalUrl}\n`, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ── Socket.io ─────────────────────────────────────────────────────
// Connection handling lives in sockets/index.js. viewers is shared by reference with
// hunts-core so live counts stay coherent.
require('./sockets')(io, {
  getPublicHunts, publicHuntView, emitHubUpdate, tenantOf, integrations, viewers, hunts,
  overdrop,
});

server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
