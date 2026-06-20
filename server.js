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
  canAccessModHunt, requireModHuntAccess,
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
  cookie: { secure: true, sameSite: 'none', maxAge: 7 * 24 * 60 * 60 * 1000 }
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
  callbackURL: process.env.DISCORD_CALLBACK_URL || `http://localhost:${PORT}/auth/discord/callback`,
  scope: ['identify']
}, (access, refresh, profile, done) => done(null, {
  id: profile.id,
  username: profile.username,
  displayName: profile.global_name || profile.username,
  avatar: profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator||0)%5}.png`
})));
passport.serializeUser((u,d) => d(null,u));
passport.deserializeUser((u,d) => d(null,u));

// ── Auth ───────────────────────────────────────────────────────────
app.get('/auth/discord', (req, res, next) => {
  if (req.query.returnTo) req.session.returnTo = req.query.returnTo;
  passport.authenticate('discord')(req, res, next);
});
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: `${FRONTEND_URL}/?error=auth` }),
  (req, res) => {
    // Record this user as known so they show up in equity-name autocomplete for others
    recordKnownUser(req.user);
    // Auto-join the community they signed in through (Bean today; the slug they arrived via later).
    memberships.joinCommunity(req.user.id, req.tenant.id).catch(() => {});
    const userData = Buffer.from(JSON.stringify({
      id: req.user.id, username: req.user.username,
      displayName: req.user.displayName, avatar: req.user.avatar,
      isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req), isPlatformAdmin: isPlatformAdmin(req.user)
    })).toString('base64');
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    // Signed token — frontend stores this and sends as Bearer in case cookies are blocked
    const token = signToken(req.user);
    const returnParam = returnTo !== '/' ? `&returnTo=${encodeURIComponent(returnTo)}` : '';
    res.redirect(`${FRONTEND_URL}/?auth=${encodeURIComponent(userData)}&t=${encodeURIComponent(token)}${returnParam}`);
  }
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect(FRONTEND_URL)));
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  // Anyone who hits /auth/me with a valid session has logged in at some point.
  // Record (or refresh) them in known_users so they show up in equity autocomplete.
  recordKnownUser(req.user);
  // Auto-attribute to the community they're browsing (Bean by default) — idempotent, so a
  // returning user keeps their original join date and this just no-ops after the first time.
  memberships.joinCommunity(req.user.id, req.tenant.id).catch(() => {});
  res.json({ user: { ...req.user, isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req), isPlatformAdmin: isPlatformAdmin(req.user) } });
});

// Public list of known users for equity-name autocomplete.
// Returns {id, displayName, avatar} for everyone who's ever logged in, sorted by recency.
app.get('/api/known-users', async (req, res) => {
  if (!pgPool) return res.json([]);
  try {
    const r = await pgPool.query(
      `SELECT user_id AS id, display_name AS "displayName", avatar
       FROM known_users
       ORDER BY last_seen DESC
       LIMIT 500`
    );
    res.json(r.rows);
  } catch(e) {
    console.error('[known_users] list failed:', e.message);
    res.json([]);
  }
});

// ── Community memberships ──────────────────────────────────────────
// GET /api/my-communities — tenant slugs the logged-in user belongs to.
app.get('/api/my-communities', requireAuth, async (req, res) => {
  res.json({ communities: await memberships.getUserCommunities(req.user.id) });
});

// POST /api/communities/:slug/join — join a community (the slug in the path, validated against tenants).
app.post('/api/communities/:slug/join', requireAuth, async (req, res) => {
  const t = tenants.getTenantBySlug(String(req.params.slug));
  if (!t) return res.status(404).json({ error: 'Unknown community' });
  await memberships.joinCommunity(req.user.id, t.id);
  res.json({ ok: true, communities: await memberships.getUserCommunities(req.user.id) });
});

// POST /api/communities/:slug/leave — leave a community.
app.post('/api/communities/:slug/leave', requireAuth, async (req, res) => {
  const t = tenants.getTenantBySlug(String(req.params.slug));
  if (!t) return res.status(404).json({ error: 'Unknown community' });
  await memberships.leaveCommunity(req.user.id, t.id);
  res.json({ ok: true, communities: await memberships.getUserCommunities(req.user.id) });
});

// ── State ──────────────────────────────────────────────────────────
const viewers = {};

// Persistence layer (hunt/archive state + Postgres hunts_kv) lives in lib/persistence.js.
// hunts/archive are shared singletons owned there — imported by reference, never reassigned.
const persistence = require('./lib/persistence');
const { hunts, archive, persistHunts, persistArchive, archiveHunt, unarchiveHunt } = persistence;

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
  MOD_HUNT_ID, AFFILIATE_HUNT_ID,
  huntSummary, huntCompleted, tenantOf, inTenant,
  getPublicHunts, getArchivedHunts, getAllHunts,
  emitHubUpdate, publicHuntView, emitHuntUpdate,
  uid, touch,
} = huntsCore;


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

// ── Public hunt endpoints ──────────────────────────────────────────
app.get('/api/hunts',          (req, res) => res.json(getPublicHunts(req.tenant.id)));
app.get('/api/hunts/archived', (req, res) => res.json(getArchivedHunts(req.tenant.id)));

// Recent "bangers" — individual slot hits at/above the multiplier threshold,
// gathered from live + archived hunts. Powers the Hub highlight reel.
// /api/bangers moved to routes/misc.routes.js (mounted below near the slots router).

// Fetch a specific archived hunt snapshot. One user can have many archived hunts so the
// archivedAt timestamp is the tiebreaker. Always returned as readonly (canEdit/canAddCalls=false).
app.get('/api/hunts/:userId/archived/:archivedAt', (req, res) => {
  const { userId, archivedAt } = req.params;
  const found = archive.find(h => h.user?.id === userId && h.archivedAt === archivedAt);
  if (!found) return res.status(404).json({error:'Archived hunt not found'});
  res.json({ ...found, canEdit: false, canAddCalls: false });
});

app.get('/api/hunts/:userId', (req, res) => {
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  if (!hunt.isLive && !hunt.archivedAt && !(req.user && canEditHunt(req, req.params.userId)))
    return res.status(404).json({error:'Hunt not live'});
  const canEdit  = req.user ? canEditHunt(req, req.params.userId) : false;

  // Auto-link: when a logged-in viewer visits, match their Discord name to an equity entry and store their Discord ID
  // This makes subsequent isEquityMember checks use the reliable ID-based path
  if (req.user?.id && hunt.equity) {
    const displayName = (req.user.displayName || '').toLowerCase().trim();
    const username    = (req.user.username    || '').toLowerCase().trim();
    const candidates  = new Set([
      displayName, username,
      displayName.replace(/\s+/g,''), username.replace(/\s+/g,''),
      displayName.replace(/[\d_\-\.]+$/,'').trim(),
      username.replace(/[\d_\-\.]+$/,'').trim(),
    ].filter(Boolean));
    let linked = false;
    hunt.equity = hunt.equity.map(e => {
      if (e.discordId) return e; // already linked
      const en = (e.name||'').toLowerCase().trim();
      const enNoSp = en.replace(/\s+/g,'');
      let matches = false;
      for (const c of candidates) {
        if (!c) continue;
        if (c === en || c === enNoSp) { matches = true; break; }
      }
      if (matches) {
        linked = true;
        return { ...e, discordId: req.user.id, name: req.user.displayName || e.name };
      }
      return e;
    });
    if (linked) { persistHunts(); emitHuntUpdate(req.params.userId); }
  }

  const canCalls = req.user ? (canEdit || isEquityMember(req.user, req.params.userId)) : false;
  if (canEdit) {
    res.json({ ...hunt, canEdit, canAddCalls: canCalls });
  } else {
    // Viewers don't need internal linkage/permission data — strip Discord IDs,
    // the editor list, and call-permission IDs from the public payload.
    const { invitedEditors, callsPermissions, publicCallsPin, ...pub } = hunt;
    res.json({
      ...pub,
      requiresPin: !!publicCallsPin,
      equity: (hunt.equity || []).map(({ discordId, ...e }) => e),
      canEdit, canAddCalls: canCalls,
    });
  }
});

// ── My hunt ────────────────────────────────────────────────────────
app.get('/api/my-hunt', requireAuth, (req, res) => res.json(hunts[req.user.id] || null));

// Seed equity when a hunt is created/reset: VIP starts with Bean, solo with
// just the runner, community empty.
function initialEquity(huntType, user, tenant, balance) {
  const userName = user?.displayName || user?.username || '';
  if (huntType === 'vip') {
    const b = (tenant && tenant.branding) || {};
    const hostName = b.hostName || 'Bean';
    const hostId   = (tenant && tenant.hostDiscordId) || null;
    // Interim id: keep 'bean_auto' for the Bean tenant so the live frontend's crown logic
    // is unaffected until the frontend keys the crown off discordId/crownDiscordId.
    const id = (tenant && tenant.slug && tenant.slug !== 'bean') ? `host_auto:${tenant.slug}` : 'bean_auto';
    return [{ id, discordId: hostId, name: hostName, amount: balance != null ? balance : 1000, isRollWinner: false }];
  }
  if (huntType === 'solo') return [{ id:'creator_auto', name: userName, amount: balance != null ? balance : 0, isRollWinner: false }];
  // community: seed a creator row only when a balance was given; else empty (today's behavior)
  if (balance != null) return [{ id:'creator_auto', name: userName, amount: balance, isRollWinner: false }];
  return [];
}
app.post('/api/my-hunt/start', requireAuth, (req, res) => {
  const { huntType = 'community', startingBalance, currency } = req.body;
  if (huntType === 'vip' && !reqIsVipHost(req))
    return res.status(403).json({error:'Not authorised for VIP hunts'});
  if (currency !== undefined && !['USD','CAD','ARS'].includes(currency))
    return res.status(400).json({ error: 'Invalid currency' });
  const bal = (Number.isFinite(+startingBalance) && +startingBalance >= 0) ? +startingBalance : undefined;
  // One active hunt per user: block a new hunt while the current one is still
  // live or has progress (bonuses/calls). The user must End or Reset it first.
  // An ended hunt (archivedAt set) or an empty fresh shell can be replaced.
  const current = hunts[req.user.id];
  if (current && !current.archivedAt && (current.isLive || current.bonuses?.length > 0 || current.calls?.length > 0)) {
    return res.status(409).json({ error: 'You already have an active hunt. End or reset it before starting a new one.' });
  }
  // Archive previous hunt if it had any bonuses
  if (hunts[req.user.id] && hunts[req.user.id].bonuses?.length > 0) {
    if (!hunts[req.user.id].archivedAt) hunts[req.user.id].archivedAt = new Date().toISOString();
    archiveHunt(hunts[req.user.id]);
  }
  hunts[req.user.id] = {
    user: req.user, huntId: uid(), isLive: false, startedAt: null, archivedAt: null, tenantId: req.tenant.id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    huntType, bonuses: [], equity: initialEquity(huntType, req.user, req.tenant, bal), calls: [], invitedEditors: [], callLimit: huntType === 'solo' ? 0 : 10, huntMode: 'hunting', roundRobin: true, lockTop4: false, currency: currency || 'USD', publicCalls: false, publicCallsPin: null
  };
  persistHunts();
  res.json({ok:true});
});

app.post('/api/my-hunt/golive', requireAuth, (req, res) => {
  if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
  hunts[req.user.id].isLive    = true;
  hunts[req.user.id].startedAt = new Date().toISOString();
  hunts[req.user.id].updatedAt = new Date().toISOString();
  hunts[req.user.id].archivedAt= null;
  emitHubUpdate(req.tenant.id); // emitHubUpdate calls persistHunts
  io.to(`hunt:${req.user.id}`).emit('hunt:update', publicHuntView(hunts[req.user.id]));
  res.json({ok:true});
});

app.post('/api/my-hunt/end', requireAuth, (req, res) => {
  const h = hunts[req.user.id];
  if (h) {
    h.isLive = false;
    h.updatedAt = new Date().toISOString();
    if (!h.huntId) h.huntId = uid();                       // backfill legacy hunts so the archive can dedupe
    if (!h.archivedAt) h.archivedAt = new Date().toISOString(); // stamp once — re-ending won't move it
    archiveHunt(h);                                         // upsert: refreshes the snapshot, never duplicates
    emitHubUpdate(req.tenant.id);
    io.to(`hunt:${req.user.id}`).emit('hunt:update', publicHuntView(h));
  }
  res.json({ok:true});
});

// Reopen a hunt ended by mistake: flip it back to live and pull its snapshot out of the
// archive, so history never keeps a copy of a hunt that's running again.
app.post('/api/my-hunt/reopen', requireAuth, (req, res) => {
  const h = hunts[req.user.id];
  if (!h) return res.status(404).json({error:'No hunt'});
  unarchiveHunt(h);
  h.isLive = true;
  h.updatedAt = new Date().toISOString();
  h.archivedAt = null;
  if (!h.startedAt) h.startedAt = new Date().toISOString();
  emitHubUpdate(req.tenant.id);
  io.to(`hunt:${req.user.id}`).emit('hunt:update', publicHuntView(h));
  res.json({ok:true});
});

app.post('/api/my-hunt/reset', requireAuth, (req, res) => {
  // Archive the hunt before wiping it
  if (hunts[req.user.id] && hunts[req.user.id].bonuses?.length > 0) {
    if (!hunts[req.user.id].archivedAt) hunts[req.user.id].archivedAt = new Date().toISOString();
    archiveHunt(hunts[req.user.id]);
  }
  // Preserve the hunt type across a reset — resetting a VIP hunt should stay
  // VIP (re-seeded with Bean), not silently demote to community.
  const keepType = ['vip','solo'].includes(hunts[req.user.id]?.huntType) ? hunts[req.user.id].huntType : 'community';
  hunts[req.user.id] = { user: req.user, huntId: uid(), isLive: false, startedAt: null, archivedAt: null, tenantId: req.tenant.id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    huntType: keepType, bonuses: [], equity: initialEquity(keepType, req.user, req.tenant), calls: [], invitedEditors: [], callLimit: keepType === 'solo' ? 0 : 10, huntMode: 'hunting', roundRobin: true, lockTop4: false, currency: 'USD', publicCalls: false, publicCallsPin: null };
  persistHunts();
  emitHubUpdate(req.tenant.id);
  res.json({ok:true});
});

app.put('/api/my-hunt', requireAuth, (req, res) => {
  if (rejectBadHuntInput(req, res)) return;
  if (!hunts[req.user.id]) hunts[req.user.id] = {
    user: req.user, huntId: uid(), isLive: false, startedAt: null, archivedAt: null, tenantId: req.tenant.id,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    huntType: 'community', bonuses: [], equity: [], calls: [], invitedEditors: [], callLimit: 10, currency: 'USD', publicCalls: false, publicCallsPin: null
  };
  const { bonuses, equity, calls, huntType, callLimit, huntMode, roundRobin, lockTop4, currency, publicCalls, publicCallsPin, currentSlot } = req.body;
  if (bonuses    !== undefined) hunts[req.user.id].bonuses    = bonuses;
  if (equity     !== undefined) hunts[req.user.id].equity     = equity;
  if (calls      !== undefined) hunts[req.user.id].calls      = calls;
  if (huntType   !== undefined) {
    if (huntType === 'vip' && !reqIsVipHost(req))
      return res.status(403).json({error:'Not authorised for VIP hunt'});
    hunts[req.user.id].huntType = huntType;
  }
  if (callLimit  !== undefined) hunts[req.user.id].callLimit  = callLimit;
  if (huntMode   !== undefined) hunts[req.user.id].huntMode   = huntMode;
  if (roundRobin !== undefined) hunts[req.user.id].roundRobin = roundRobin;
  if (lockTop4   !== undefined) hunts[req.user.id].lockTop4   = lockTop4;
  if (currency   !== undefined) hunts[req.user.id].currency   = currency;
  if (publicCalls    !== undefined) hunts[req.user.id].publicCalls    = publicCalls;
  if (publicCallsPin !== undefined) hunts[req.user.id].publicCallsPin = publicCallsPin;
  if (currentSlot !== undefined) hunts[req.user.id].currentSlot = currentSlot;
  touch(req.user.id);
  persistHunts();
  io.to(`hunt:${req.user.id}`).emit('hunt:update', publicHuntView(hunts[req.user.id]));
  emitHubUpdate(req.tenant.id);
  res.json({ok:true});
});

// ── Invite editor ──────────────────────────────────────────────────
app.post('/api/my-hunt/invite', requireAuth, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({error:'username required'});
  if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
  if (!hunts[req.user.id].invitedEditors) hunts[req.user.id].invitedEditors = [];
  const lower = username.toLowerCase().trim();
  if (!hunts[req.user.id].invitedEditors.includes(lower))
    hunts[req.user.id].invitedEditors.push(lower);
  persistHunts();
  io.to(`hunt:${req.user.id}`).emit('hunt:reinvite', { huntUserId: req.user.id });
  res.json({ok:true, invitedEditors: hunts[req.user.id].invitedEditors});
});

app.delete('/api/my-hunt/invite', requireAuth, (req, res) => {
  const { username } = req.body;
  if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
  hunts[req.user.id].invitedEditors = (hunts[req.user.id].invitedEditors||[])
    .filter(u => u !== username.toLowerCase().trim());
  persistHunts();
  io.to(`hunt:${req.user.id}`).emit('hunt:reinvite', { huntUserId: req.user.id });
  res.json({ok:true, invitedEditors: hunts[req.user.id].invitedEditors});
});

// Mod hunt + Affiliate hunt — two fixed-key shared hunts (routes/mod-hunt.routes.js).
app.use(require('./routes/mod-hunt.routes')({
  hunts, archive, io, persistHunts, archiveHunt,
  requireModHuntAccess, MOD_HUNT_ID, AFFILIATE_HUNT_ID,
  uid, touch, publicHuntView, rejectBadHuntInput,
}));


// Shared add-call logic for both the equity-member endpoint and the public link endpoint.
// `isEditor` controls the rolling-mode + callLimit exemptions (owners/admins bypass them).
function addCallToHunt(hunt, user, slot, isEditor) {
  if (!slot?.trim()) return { error: 'Slot name required', status: 400 };

  // Block non-editors from adding calls when the hunt is rolling
  if (hunt.huntMode === 'rolling' && !isEditor)
    return { error: 'Cannot add calls while the hunt is rolling', status: 403 };

  // Duplicate check (normalized: "CULT" === "CULT.")
  if (hunt.calls.some(c => normalizeSlot(c.slot) === normalizeSlot(slot)))
    return { error: `"${slot}" is already in the queue`, status: 400 };

  // Per-person limit (not applied to editors/admins)
  const callerName = nameOf(user);
  if (hunt.callLimit > 0 && !isEditor) {
    const myCount = hunt.calls.filter(c => c.user.toLowerCase() === callerName).length;
    if (myCount >= hunt.callLimit)
      return { error: `You've reached the limit of ${hunt.callLimit} calls`, status: 400 };
  }

  const newCall = { id: Math.random().toString(36).slice(2,8), slot: slot.trim(), user: user.displayName||user.username, status: 'pending' };
  // Insert after first 3 pending calls so top 3 stay stable
  const pendingCalls = hunt.calls.filter(c=>c.status==='pending');
  const otherCalls   = hunt.calls.filter(c=>c.status!=='pending');
  const insertAt     = Math.min(3, pendingCalls.length);
  pendingCalls.splice(insertAt, 0, newCall);
  hunt.calls = [...pendingCalls, ...otherCalls];
  hunt.updatedAt = new Date().toISOString();
  persistHunts();
  io.to(`hunt:${hunt.user.id}`).emit('hunt:update', publicHuntView(hunt));
  return { ok: true, call: newCall };
}

// ── Equity member: add slot call ────────────────────────────────────
app.post('/api/hunts/:userId/calls', requireAuth, (req, res) => {
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  if (!canEditHunt(req, req.params.userId) && !isEquityMember(req.user, req.params.userId))
    return res.status(403).json({error:'Not an equity member'});

  const isEditor = canEditHunt(req, req.params.userId);
  const result = addCallToHunt(hunt, req.user, req.body.slot, isEditor);
  if (result.error) return res.status(result.status).json({error: result.error});
  res.json({ok:true, call: result.call});
});

// ── Public link: add slot call (any logged-in user, optional PIN, no equity membership) ──
app.post('/api/hunts/:userId/public-calls', requireAuth, (req, res) => {
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  if (!hunt.publicCalls) return res.status(403).json({error:'Call link is disabled'});
  if (hunt.publicCallsPin && req.body.pin !== hunt.publicCallsPin)
    return res.status(403).json({error:'Incorrect PIN'});

  // Owners/admins/editors keep their exemptions; everyone else is a limited submitter.
  const isEditor = canEditHunt(req, req.params.userId);
  const result = addCallToHunt(hunt, req.user, req.body.slot, isEditor);
  if (result.error) return res.status(result.status).json({error: result.error});
  res.json({ok:true, call: result.call});
});

// ── Edit any hunt (admin/editor) ───────────────────────────────────
app.put('/api/hunts/:userId', requireAuth, (req, res) => {
  if (!canEditHunt(req, req.params.userId)) return res.status(403).json({error:'Not authorised'});
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  if (rejectBadHuntInput(req, res)) return;
  const { bonuses, equity, calls, huntType, callLimit, huntMode, roundRobin, lockTop4, currency, publicCalls, publicCallsPin, currentSlot } = req.body;
  if (bonuses     !== undefined) hunt.bonuses     = bonuses;
  if (equity      !== undefined) hunt.equity      = equity;
  if (calls       !== undefined) hunt.calls       = calls;
  if (huntType    !== undefined) hunt.huntType    = huntType;
  if (callLimit   !== undefined) hunt.callLimit   = callLimit;
  if (huntMode    !== undefined) hunt.huntMode    = huntMode;
  if (roundRobin  !== undefined) hunt.roundRobin  = roundRobin;
  if (lockTop4    !== undefined) hunt.lockTop4    = lockTop4;
  if (currency    !== undefined) hunt.currency    = currency;
  if (publicCalls    !== undefined) hunt.publicCalls    = publicCalls;
  if (publicCallsPin !== undefined) hunt.publicCallsPin = publicCallsPin;
  if (currentSlot !== undefined) hunt.currentSlot = currentSlot;
  hunt.updatedAt = new Date().toISOString();
  persistHunts();
  io.to(`hunt:${req.params.userId}`).emit('hunt:update', publicHuntView(hunt));
  emitHubUpdate(req.tenant.id);
  res.json({ok:true});
});

// ── Admin ──────────────────────────────────────────────────────────
app.get('/api/admin/hunts', requireAdmin, (req, res) => res.json(getAllHunts(req.tenant.id)));

// Lightweight dashboard counts for the current tenant.
app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  const tenantId = req.tenant?.id || 'bean';
  let userCount = 0, recentLogins = [];
  if (pgPool) {
    try {
      const c = await pgPool.query(
        'SELECT COUNT(*)::int AS n FROM community_members WHERE tenant_id=$1', [tenantId]);
      userCount = c.rows[0]?.n || 0;
      const r = await pgPool.query(`
        SELECT ku.user_id, ku.display_name, ku.avatar, ku.last_seen
        FROM community_members cm JOIN known_users ku ON ku.user_id = cm.user_id
        WHERE cm.tenant_id=$1 ORDER BY ku.last_seen DESC NULLS LAST LIMIT 10`, [tenantId]);
      recentLogins = r.rows.map(u => ({
        id: u.user_id, displayName: u.display_name, avatar: u.avatar, lastSeen: u.last_seen }));
    } catch (e) { console.error('[admin] overview failed:', e.message); }
  }
  // getAllHunts returns all hunts (live + created + archived snapshots) for the tenant.
  // getArchivedHunts returns only completed archived hunts for the tenant.
  const allTenantHunts = getAllHunts(tenantId);
  const activeHuntCount = allTenantHunts.filter(h => h.isLive && !h.archivedAt).length;
  const archivedHuntCount = getArchivedHunts(tenantId).length;
  res.json({
    communityName: req.tenant?.displayName || 'Bean',
    userCount, activeHuntCount, archivedHuntCount,
    recentLogins,
  });
});

// ── Platform-admin management ──────────────────────────────────────
// List all platform admins with their source (owner | env | db) for the UI.
app.get('/api/admin/platform-admins', requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const OWNERS = tenants.PLATFORM_OWNER_IDS;
    const rows = []; // { discordId, source }
    for (const id of OWNERS) rows.push({ discordId: id, source: 'owner' });
    for (const id of ADMIN_IDS) if (!OWNERS.includes(id)) rows.push({ discordId: id, source: 'env' });
    const dbAdmins = await admins.listDbAdmins();
    for (const a of dbAdmins) {
      if (OWNERS.includes(a.discordId) || ADMIN_IDS.includes(a.discordId)) continue; // dedup; owner/env win
      rows.push({ discordId: a.discordId, source: 'db', addedBy: a.addedBy, addedAt: a.addedAt });
    }
    // Enrich with display name + avatar from known_users (best-effort).
    let enriched = rows;
    if (pgPool && rows.length) {
      try {
        const ids = rows.map(r => r.discordId);
        const r = await pgPool.query(
          `SELECT user_id, display_name, avatar FROM known_users WHERE user_id = ANY($1)`, [ids]);
        const byId = {};
        for (const u of r.rows) byId[u.user_id] = u;
        enriched = rows.map(row => ({
          ...row,
          displayName: byId[row.discordId]?.display_name || null,
          avatar: byId[row.discordId]?.avatar || null,
        }));
      } catch (e) { console.error('[admin] platform-admins enrich failed:', e.message); }
    }
    res.json(enriched);
  } catch (e) {
    console.error('[admin] platform-admins list failed:', e.message);
    res.status(500).json({ error: 'Failed to list admins' });
  }
});

// Add a DB platform admin. Owner/env entries are not addable here (they already are admins).
app.post('/api/admin/platform-admins', requireAuth, requirePlatformAdmin, async (req, res) => {
  const discordId = String(req.body?.discordId || '').trim();
  if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({error:'Valid Discord ID required'});
  if (tenants.isPlatformOwnerId(discordId)) return res.status(400).json({error:'Owner is always admin'});
  try {
    await admins.addDbAdmin(discordId, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] platform-admins add failed:', e.message);
    res.status(500).json({ error: 'Failed to add admin' });
  }
});

// Remove a DB platform admin. Owner and env-var admins cannot be removed here.
app.delete('/api/admin/platform-admins/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (tenants.isPlatformOwnerId(id)) return res.status(400).json({error:'Owner cannot be removed'});
  if (ADMIN_IDS.includes(id)) return res.status(400).json({error:'Env admin — managed via Railway ADMIN_IDS'});
  try {
    await admins.removeDbAdmin(id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] platform-admins remove failed:', e.message);
    res.status(500).json({ error: 'Failed to remove admin' });
  }
});

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
// Manual trigger for admins — used for verification and on-demand cleanup.
app.post('/api/admin/hunts/cleanup', requireAdmin, (req, res) => res.json({ ok: true, ...cleanupStaleHunts() }));

app.post('/api/admin/hunts/:userId/end', requireAdmin, (req, res) => {
  const h = hunts[req.params.userId];
  if (!h) return res.status(404).json({error:'Not found'});
  h.isLive = false;
  if (!h.huntId) h.huntId = uid();
  if (!h.archivedAt) h.archivedAt = new Date().toISOString();
  archiveHunt(h);
  emitHubUpdate(req.tenant.id); io.to(`hunt:${req.params.userId}`).emit('hunt:update', publicHuntView(h));
  res.json({ok:true});
});

app.post('/api/admin/hunts/:userId/reopen', requireAdmin, (req, res) => {
  const h = hunts[req.params.userId];
  if (!h) return res.status(404).json({error:'Not found'});
  unarchiveHunt(h);
  h.isLive = true; h.archivedAt = null;
  if (!h.startedAt) h.startedAt = new Date().toISOString();
  emitHubUpdate(req.tenant.id); io.to(`hunt:${req.params.userId}`).emit('hunt:update', publicHuntView(h));
  res.json({ok:true});
});

app.delete('/api/admin/hunts/:userId', requireAdmin, (req, res) => {
  if (!hunts[req.params.userId]) return res.status(404).json({error:'Not found'});
  delete hunts[req.params.userId]; emitHubUpdate(req.tenant.id);
  res.json({ok:true});
});

// Delete an archived hunt. Two archived hunts can share a userId (same user, multiple completed hunts),
// so we need archivedAt as a tiebreaker to identify the exact entry.
app.delete('/api/admin/hunts/archived/:userId/:archivedAt', requireAdmin, (req, res) => {
  const { userId, archivedAt } = req.params;
  const idx = archive.findIndex(h => h.user?.id === userId && h.archivedAt === archivedAt);
  if (idx === -1) return res.status(404).json({error:'Archived hunt not found'});
  archive.splice(idx, 1);
  persistArchive();
  emitHubUpdate(req.tenant.id);
  res.json({ok:true});
});

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
app.use(require('./routes/slots.routes')({ slots }));

// Misc leaf routes: /api/bangers (reads hunts+archive), /api/tickets, /api/health.
app.use(require('./routes/misc.routes')({ hunts, archive }));

// User settings + admin user-management routes (helpers in lib/settings.js).
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, requireAuth, requireAdmin,
}));

// ── Call Permission Requests ─────────────────────────────────────
// Store pending requests per hunt
// huntCallRequests[huntOwnerId] = [{id, userId, displayName, avatar, requestedAt}]
const huntCallRequests = {};

// Request permission to add calls
app.post('/api/hunts/:userId/request-calls', requireAuth, (req, res) => {
  const { userId } = req.params;
  const hunt = hunts[userId];
  if (!hunt || !hunt.isLive) return res.status(404).json({ error: 'Hunt not found' });
  if (isEquityMember(req.user, userId)) return res.json({ status: 'already_member' });

  if (!huntCallRequests[userId]) huntCallRequests[userId] = [];
  const existing = huntCallRequests[userId].find(r => r.userId === req.user.id);
  if (existing) return res.json({ status: 'pending' });

  const request = {
    id: uid(),
    userId: req.user.id,
    displayName: req.user.displayName || req.user.username,
    avatar: req.user.avatar ? `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png` : null,
    requestedAt: new Date().toISOString(),
  };
  huntCallRequests[userId].push(request);

  // Notify the hunt owner
  io.to(`hunt:${userId}`).emit('calls:request:new', { requests: huntCallRequests[userId] });
  res.json({ status: 'requested' });
});

// Get pending requests (hunt owner only)
app.get('/api/hunts/:userId/call-requests', requireAuth, (req, res) => {
  if (req.user.id !== req.params.userId && !reqIsAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json(huntCallRequests[req.params.userId] || []);
});

// Grant or deny a request
app.post('/api/hunts/:userId/call-requests/:requestId', requireAuth, (req, res) => {
  const { userId, requestId } = req.params;
  const { action } = req.body; // 'grant' or 'deny'
  if (req.user.id !== userId && !reqIsAdmin(req)) return res.status(403).json({ error: 'Forbidden' });

  const requests = huntCallRequests[userId] || [];
  const reqItem = requests.find(r => r.id === requestId);
  if (!reqItem) return res.status(404).json({ error: 'Request not found' });

  // Remove from pending
  huntCallRequests[userId] = requests.filter(r => r.id !== requestId);

  if (action === 'grant') {
    if (!hunts[userId].callsPermissions) hunts[userId].callsPermissions = [];
    if (!hunts[userId].callsPermissions.includes(reqItem.userId)) {
      hunts[userId].callsPermissions.push(reqItem.userId);
    }
    persistHunts();
    // Notify the requester
    io.to(`hunt:${userId}`).emit('calls:granted', { userId: reqItem.userId });
  } else {
    io.to(`hunt:${userId}`).emit('calls:denied', { userId: reqItem.userId });
  }

  // Update owner's notification count
  io.to(`hunt:${userId}`).emit('calls:request:update', { requests: huntCallRequests[userId] });
  res.json({ ok: true });
});

// ── Socket.io ─────────────────────────────────────────────────────
// Track socket → { watchingHuntId, user } for permission-aware updates
const socketUsers = {};

io.on('connection', socket => {
  // Tenant slug from the handshake query (?_tenant=); defaults to bean for back-compat.
  const slug = socket.handshake.query._tenant || 'bean';

  socket.on('watch:hub', () => {
    socket.join('hub:' + slug);
    socket.emit('hub:update', getPublicHunts(slug));
    socket.emit('bean:live', integrations.getLiveStatus(slug));
  });

  socket.on('watch:hunt', userId => {
    socket.join(`hunt:${userId}`);
    socketUsers[socket.id] = { watchingHuntId: userId };
    viewers[userId] = (viewers[userId]||0) + 1;
    const h = hunts[userId];
    if (h) socket.emit('hunt:update', publicHuntView(h));
    emitHubUpdate(tenantOf(h || {}));
    socket.on('disconnect', () => {
      viewers[userId] = Math.max(0,(viewers[userId]||1)-1);
      delete socketUsers[socket.id];
      emitHubUpdate(tenantOf(hunts[userId] || {}));
    });
  });

  socket.on('leave:hunt', userId => {
    socket.leave(`hunt:${userId}`);
    if (viewers[userId]) viewers[userId] = Math.max(0, viewers[userId] - 1);
    emitHubUpdate(tenantOf(hunts[userId] || {}));
  });

  // Client sends their user id so we can compute canEdit for them
  socket.on('identify', (userId) => {
    if (socketUsers[socket.id]) socketUsers[socket.id].userId = userId;
  });

  // On reinvite, socket re-fetches permissions from the API
  // (handled client-side in WatchHunt)
});

server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
