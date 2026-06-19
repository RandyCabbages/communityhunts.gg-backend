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
const ADMIN_IDS      = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const VIP_IDS        = (process.env.VIP_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const TICKET_EMAILS = (process.env.TICKET_EMAILS || 'nesgoomba@gmail.com,luimeneghim@gmail.com').split(',').map(s=>s.trim()).filter(Boolean);
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const TICKET_FROM = (process.env.TICKET_FROM || 'CommunityHunts Tickets <onboarding@resend.dev>').trim();

function nameOf(user) { return (user?.displayName || user?.username || '').toLowerCase().trim(); }
// Normalize slot name for dedup: strip punctuation, collapse whitespace, lowercase
function normalizeSlot(name) { return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function isAdmin(user) {
  // ID-based only — display names are spoofable. Real admins live in ADMIN_IDS.
  return !!(user && user.id && ADMIN_IDS.includes(user.id));
}
function isVipHost(user) {
  // ID-based only (see isAdmin). VIP hosts — and admins, who are also listed — in VIP_IDS.
  return !!(user && user.id && VIP_IDS.includes(user.id));
}

// ── HMAC-signed auth tokens ────────────────────────────────────────
// Fallback when third-party cookies are blocked (Safari, Brave, etc).
// Token format: base64url(payload) + "." + base64url(hmacSha256(payload))
// Payload: JSON {id, username, displayName, avatar, exp}
const crypto = require('crypto');
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlDecode(s) {
  s = s.replace(/-/g,'+').replace(/_/g,'/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
function signToken(user) {
  const payload = {
    id: user.id, username: user.username,
    displayName: user.displayName, avatar: user.avatar,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig || ''), expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch(e) { return null; }
}
function canEditHunt(user, huntOwnerId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.id === huntOwnerId) return true;
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  const name = nameOf(user);
  const nameNoSp = name.replace(/\s+/g,'');
  const invites = hunt.invitedEditors || [];
  return invites.some(inv => {
    const invLow = inv.toLowerCase().trim();
    return invLow === name || invLow === nameNoSp || 
           invLow.replace(/\s+/g,'') === name || invLow.replace(/\s+/g,'') === nameNoSp ||
           inv === user.id;
  });
}
function isEquityMember(user, huntOwnerId) {
  if (!user) return false;
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  // Check callsPermissions (explicitly granted via request)
  if (user?.id && hunt.callsPermissions && hunt.callsPermissions.includes(user.id)) return true;
  const userId = user?.id;
  // Build all name variants for this user to match against
  const displayName = (user.displayName || '').toLowerCase().trim();
  const username    = (user.username    || '').toLowerCase().trim();
  const candidates  = new Set([
    displayName,
    username,
    displayName.replace(/\s+/g,''),
    username.replace(/\s+/g,''),
    // strip trailing numbers/symbols often appended to Discord names
    displayName.replace(/[\d_\-\.]+$/,'').trim(),
    username.replace(/[\d_\-\.]+$/,'').trim(),
  ].filter(Boolean));

  return hunt.equity.some(e => {
    if (!e.name && !e.discordId) return false;
    // Discord ID match (most reliable — set after auto-link)
    if (userId && e.discordId && e.discordId === userId) return true;
    // Name match — compare equity entry name against all user name variants
    const en = (e.name||'').toLowerCase().trim();
    const enNoSp = en.replace(/\s+/g,'');
    for (const c of candidates) {
      if (!c) continue;
      if (c === en || c === enNoSp) return true;
      // Equity name starts with or is contained in user's name (or vice versa)
      // e.g. equity "walker" matches Discord "WalkerGames" or "walker_123"
      if (c.startsWith(en) || en.startsWith(c)) return true;
    }
    return false;
  });
}

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

// Token-based auth fallback — for browsers that block third-party cookies.
// If req.user wasn't set by passport session, check for Authorization: Bearer <token>
app.use((req, res, next) => {
  if (!req.user) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const payload = verifyToken(auth.slice(7));
      if (payload) {
        req.user = {
          id: payload.id, username: payload.username,
          displayName: payload.displayName, avatar: payload.avatar
        };
        // Also record in known_users so they show in equity autocomplete for others
        recordKnownUser(req.user);
      }
    }
  }
  next();
});

// Resolve the tenant for every /api request. Defaults to Bean when MULTI_TENANT is off
// or no X-Tenant-Slug is sent (back-compat — the current frontend may not send it yet).
function resolveTenant(req, res, next) {
  const slug = req.headers['x-tenant-slug'] || req.query._tenant;
  if (!MULTI_TENANT || !slug) { req.tenant = tenants.BEAN_TENANT; return next(); }
  const t = tenants.getTenantBySlug(String(slug));
  if (!t) return res.status(404).json({ error: 'Unknown tenant' });
  req.tenant = t;
  next();
}
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
      isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req)
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
  res.json({ user: { ...req.user, isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req) } });
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
persistence.initPersistence({ pgPool, normalizeSlot })
  .then(() => startupBackfill())
  .catch(e => console.error('[persist] init error:', e.message));

// Multi-tenancy config (tenants + roles). Gated by MULTI_TENANT; defaults to Bean.
const tenants = require('./lib/tenants');
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
tenants.initTenants({ pgPool }).catch(e => console.error('[tenants] init error:', e.message));

// Community memberships (which communities a user belongs to). One-time backfill attributes
// every previously-known user to Bean; new users auto-join the slug they sign in through.
const memberships = require('./lib/memberships');
memberships.initMemberships({ pgPool })
  .then(() => memberships.backfillExistingUsersToBean(tenants.BEAN_TENANT.id))
  .catch(e => console.error('[memberships] init error:', e.message));

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
function getPublicHunts(tenantId)   { return Object.values(hunts).filter(h=>h.isLive && inTenant(h,tenantId)).map(huntSummary); }
// Public Archived tab: only completed hunts (every bonus opened). Incomplete ended hunts are
// hidden here — admins still see them in the All tab, and the janitor eventually reaps them.
function getArchivedHunts(tenantId) { return archive.filter(h=>inTenant(h,tenantId) && huntCompleted(h)).map(huntSummary); }
// Admin All tab: every hunt — created, live, and archived. Union of the current hunts (created/
// live/ended) with archived snapshots whose hunt is no longer current, deduped by huntId.
function getAllHunts(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId));
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

function requireAuth(req, res, next)  { if (!req.user) return res.status(401).json({error:'Not authenticated'}); next(); }
// Tenant-aware gates: when MULTI_TENANT is on, resolve against req.tenant; else the env-based globals.
function reqIsAdmin(req)   { return MULTI_TENANT ? tenants.isTenantAdmin(req.user, req.tenant) : isAdmin(req.user); }
function reqIsVipHost(req) { return MULTI_TENANT ? tenants.isTenantVip(req.user, req.tenant)   : (isAdmin(req.user)||isVipHost(req.user)); }
function requireAdmin(req, res, next) { if (!req.user||!reqIsAdmin(req)) return res.status(403).json({error:'Admin only'}); next(); }
function uid() { return Math.random().toString(36).slice(2, 8); }
// Stamp a hunt's last-activity time so the stale-hunt janitor (cleanupStaleHunts) can measure idleness.
function touch(userId) { const h = hunts[userId]; if (h) h.updatedAt = new Date().toISOString(); }

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
const BANGER_MIN_MULT = 300;
app.get('/api/bangers', (req, res) => {
  const out = [], seen = new Set();
  const collect = (h, live) => {
    if (!h || !h.user || !Array.isArray(h.bonuses)) return;
    const at = h.archivedAt || h.startedAt || null;
    for (const b of h.bonuses) {
      const bet = +b.bet || 0, win = +b.win || 0;
      if (bet <= 0 || win <= 0) continue;
      const mult = win / bet;
      if (mult < BANGER_MIN_MULT) continue;
      const key = `${h.user.id}|${(b.slot||'').toLowerCase()}|${bet}|${win}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        userId: h.user.id, username: h.user.displayName, avatar: h.user.avatar,
        huntType: h.huntType || 'community', live: !!live,
        at, archivedAt: h.archivedAt || null,
      });
    }
  };
  // Live hunts first so their fresher copy wins the dedupe over an archived snapshot.
  Object.values(hunts).forEach(h => { if (h.isLive) collect(h, true); });
  archive.forEach(h => collect(h, false));
  out.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return tb - ta || b.mult - a.mult;
  });
  res.json(out.slice(0, 24));
});

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
  if (!hunt.isLive && !hunt.archivedAt && !(req.user && canEditHunt(req.user, req.params.userId)))
    return res.status(404).json({error:'Hunt not live'});
  const canEdit  = req.user ? canEditHunt(req.user, req.params.userId) : false;

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
function initialEquity(huntType, user, tenant) {
  if (huntType === 'vip') {
    const b = (tenant && tenant.branding) || {};
    const hostName = b.hostName || 'Bean';
    const hostId   = (tenant && tenant.hostDiscordId) || null;
    // Interim id: keep 'bean_auto' for the Bean tenant so the live frontend's crown logic
    // is unaffected until the frontend keys the crown off discordId/crownDiscordId.
    const id = (tenant && tenant.slug && tenant.slug !== 'bean') ? `host_auto:${tenant.slug}` : 'bean_auto';
    return [{ id, discordId: hostId, name: hostName, amount: 1000, isRollWinner: false }];
  }
  if (huntType === 'solo') return [{id:'creator_auto',name:(user?.displayName||user?.username||''),amount:0,isRollWinner:false}];
  return [];
}
app.post('/api/my-hunt/start', requireAuth, (req, res) => {
  const { huntType = 'community' } = req.body;
  if (huntType === 'vip' && !reqIsVipHost(req))
    return res.status(403).json({error:'Not authorised for VIP hunts'});
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
    huntType, bonuses: [], equity: initialEquity(huntType, req.user, req.tenant), calls: [], invitedEditors: [], callLimit: 10, huntMode: 'creating', roundRobin: true, currency: 'USD', publicCalls: false, publicCallsPin: null
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
    huntType: keepType, bonuses: [], equity: initialEquity(keepType, req.user, req.tenant), calls: [], invitedEditors: [], callLimit: 10, huntMode: 'creating', roundRobin: true, currency: 'USD', publicCalls: false, publicCallsPin: null };
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
  const { bonuses, equity, calls, huntType, callLimit, huntMode, roundRobin, currency, publicCalls, publicCallsPin } = req.body;
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
  if (currency   !== undefined) hunts[req.user.id].currency   = currency;
  if (publicCalls    !== undefined) hunts[req.user.id].publicCalls    = publicCalls;
  if (publicCallsPin !== undefined) hunts[req.user.id].publicCallsPin = publicCallsPin;
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
  if (!canEditHunt(req.user, req.params.userId) && !isEquityMember(req.user, req.params.userId))
    return res.status(403).json({error:'Not an equity member'});

  const isEditor = canEditHunt(req.user, req.params.userId);
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
  const isEditor = canEditHunt(req.user, req.params.userId);
  const result = addCallToHunt(hunt, req.user, req.body.slot, isEditor);
  if (result.error) return res.status(result.status).json({error: result.error});
  res.json({ok:true, call: result.call});
});

// ── Edit any hunt (admin/editor) ───────────────────────────────────
app.put('/api/hunts/:userId', requireAuth, (req, res) => {
  if (!canEditHunt(req.user, req.params.userId)) return res.status(403).json({error:'Not authorised'});
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  if (rejectBadHuntInput(req, res)) return;
  const { bonuses, equity, calls, huntType, callLimit, huntMode, roundRobin, currency, publicCalls, publicCallsPin } = req.body;
  if (bonuses     !== undefined) hunt.bonuses     = bonuses;
  if (equity      !== undefined) hunt.equity      = equity;
  if (calls       !== undefined) hunt.calls       = calls;
  if (huntType    !== undefined) hunt.huntType    = huntType;
  if (callLimit   !== undefined) hunt.callLimit   = callLimit;
  if (huntMode    !== undefined) hunt.huntMode    = huntMode;
  if (roundRobin  !== undefined) hunt.roundRobin  = roundRobin;
  if (currency    !== undefined) hunt.currency    = currency;
  if (publicCalls    !== undefined) hunt.publicCalls    = publicCalls;
  if (publicCallsPin !== undefined) hunt.publicCallsPin = publicCallsPin;
  hunt.updatedAt = new Date().toISOString();
  persistHunts();
  io.to(`hunt:${req.params.userId}`).emit('hunt:update', publicHuntView(hunt));
  emitHubUpdate(req.tenant.id);
  res.json({ok:true});
});

// ── Admin ──────────────────────────────────────────────────────────
app.get('/api/admin/hunts', requireAdmin, (req, res) => res.json(getAllHunts(req.tenant.id)));

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

// ── User Settings ──────────────────────────────────────────────────
// ── User Settings (Postgres-backed) ───────────────────────────────
// Uses shared pgPool created at middleware setup. Falls back to file if no pool.
if (pgPool) {
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'
    )
  `).then(() => console.log('[settings] Postgres table ready'))
    .catch(e => console.error('[settings] Postgres init failed:', e.message));
  // Track everyone who's ever logged in, for equity name autocomplete
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS known_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      username TEXT,
      avatar TEXT,
      last_seen TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `).then(() => console.log('[known_users] Postgres table ready'))
    .catch(e => console.error('[known_users] init failed:', e.message));
}

// Records a user as known. Safe to call on every login.
function recordKnownUser(user) {
  if (!user?.id || !user?.displayName) return;
  if (pgPool) {
    pgPool.query(
      `INSERT INTO known_users (user_id, display_name, username, avatar, last_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         username = EXCLUDED.username,
         avatar = EXCLUDED.avatar,
         last_seen = NOW()`,
      [user.id, user.displayName, user.username || null, user.avatar || null]
    ).catch(e => console.error('[known_users] insert failed:', e.message));
  }
}

// Backfill known_users from existing user_settings (and hunts) on startup.
// Without this, returning users wouldn't appear in equity autocomplete until they re-login.
async function backfillKnownUsers() {
  if (!pgPool) return;
  let inserted = 0;
  // From user_settings — settings JSON has discordDisplayName / discordUsername fields
  try {
    const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
    for (const row of r.rows) {
      const s = row.settings || {};
      const dn = s.discordDisplayName || s.rainbetName;
      if (dn) {
        recordKnownUser({
          id: row.user_id,
          displayName: dn,
          username: s.discordUsername || null,
          avatar: s.discordAvatar || null,
        });
        inserted++;
      }
    }
  } catch(e) { console.error('[known_users] settings backfill failed:', e.message); }
  // From hunts (each hunt has a user object with displayName)
  for (const id in hunts) {
    const u = hunts[id]?.user;
    if (u?.id && u?.displayName) {
      recordKnownUser({ id: u.id, displayName: u.displayName, username: u.username, avatar: u.avatar });
      inserted++;
    }
  }
  console.log(`[known_users] backfill queued ${inserted} users`);
}
// Run backfill after hunts are loaded so the hunts loop sees data
function startupBackfill() { backfillKnownUsers().catch(e => console.error('[known_users] backfill error:', e.message)); }

const SETTINGS_FILE = path.join(__dirname, 'user_settings.json');
let userSettings = {};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    console.log(`[settings] Loaded ${Object.keys(userSettings).length} users from file`);
  }
} catch(e) { console.error('[settings] Failed to load user_settings.json:', e.message); }

async function getSettings(userId) {
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT settings FROM user_settings WHERE user_id=$1', [userId]);
      return r.rows[0]?.settings || { rainbetName: '', twitchName: '', preferredSlots: [] };
    } catch(e) { console.error('[settings] pg getSettings error:', e.message); }
  }
  return userSettings[userId] || { rainbetName: '', twitchName: '', preferredSlots: [] };
}

async function saveSettings(userId, data) {
  if (pgPool) {
    try {
      await pgPool.query(
        'INSERT INTO user_settings(user_id, settings) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET settings=$2',
        [userId, JSON.stringify(data)]
      );
      return;
    } catch(e) { console.error('[settings] pg saveSettings error:', e.message); }
  }
  // Fallback to file
  userSettings[userId] = data;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings), 'utf8'); } catch(e) {}
}

// GET /api/settings — get current user's settings
app.get('/api/settings', requireAuth, async (req, res) => {
  res.json(await getSettings(req.user.id));
});

// PUT /api/settings — save current user's settings (also stores their Discord names for lookup)
app.put('/api/settings', requireAuth, async (req, res) => {
  const current = await getSettings(req.user.id);
  const { rainbetName, twitchName, preferredSlots } = req.body;
  if (rainbetName !== undefined)    current.rainbetName    = String(rainbetName).trim().slice(0, 64);
  if (twitchName  !== undefined)    current.twitchName     = String(twitchName).trim().slice(0, 64);
  if (preferredSlots !== undefined) current.preferredSlots = (preferredSlots || []).filter(Boolean);
  // Always update Discord identity for name-based lookup by other hunt owners
  current.discordUsername    = req.user.username || '';
  current.discordDisplayName = req.user.displayName || req.user.username || '';
  current.discordId          = req.user.id;
  await saveSettings(req.user.id, current);
  res.json({ ok: true, settings: current });
});

// GET /api/settings/:userId — get another user's preferred slots and rainbet name by Discord ID
app.get('/api/settings/:userId', requireAuth, async (req, res) => {
  const s = await getSettings(req.params.userId);
  res.json({ preferredSlots: s.preferredSlots || [], rainbetName: s.rainbetName || '', twitchName: s.twitchName || '' });
});

// GET /api/settings/by-name/:name — look up another user's preferred slots & rainbet by their Discord username/displayName
// Used when a hunt owner adds a member by name and we don't know their Discord ID
app.get('/api/settings/by-name/:name', requireAuth, async (req, res) => {
  const search = (req.params.name || '').toLowerCase().trim();
  if (!search) return res.json({ preferredSlots: [], rainbetName: '', twitchName: '' });
  const searchNoSp = search.replace(/\s+/g,'');

  // Build list of all settings to search
  let allSettings = [];
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
      allSettings = r.rows.map(row => ({ userId: row.user_id, ...row.settings }));
    } catch(e) { console.error('[settings] by-name pg error:', e.message); }
  }
  if (!allSettings.length) {
    allSettings = Object.entries(userSettings).map(([uid, s]) => ({ userId: uid, ...s }));
  }

  // Find match by Discord username or displayName (case-insensitive, space-insensitive)
  const match = allSettings.find(s => {
    const candidates = [
      (s.discordUsername    || '').toLowerCase().trim(),
      (s.discordDisplayName || '').toLowerCase().trim(),
    ].filter(Boolean);
    const noSp = candidates.map(c => c.replace(/\s+/g,''));
    for (const c of candidates.concat(noSp)) {
      if (!c) continue;
      if (c === search || c === searchNoSp) return true;
      // Also match if either starts with the other (handles "walker" vs "WalkerGames")
      if (c.startsWith(search) || search.startsWith(c)) return true;
    }
    return false;
  });

  if (match) {
    return res.json({
      preferredSlots: match.preferredSlots || [],
      rainbetName:    match.rainbetName    || '',
      twitchName:     match.twitchName     || '',
      userId:         match.userId         || null,
    });
  }
  res.json({ preferredSlots: [], rainbetName: '', twitchName: '' });
});

// POST /api/admin/set-rainbet-name — let an admin manually set another user's Rainbet name.
// Accepts either { userId, rainbetName } (Discord ID known) or { name, rainbetName } (only name known).
// When only a name is supplied, a synthetic settings row is keyed by `manual:<lowercased-name>` so the
// existing by-name lookup matches via discordDisplayName.
app.post('/api/admin/set-rainbet-name', requireAdmin, async (req, res) => {
  const rainbetName = String(req.body?.rainbetName || '').trim().slice(0, 64);
  if (!rainbetName) return res.status(400).json({ error: 'rainbetName required' });
  const userId = (req.body?.userId || '').toString().trim();
  const name   = (req.body?.name   || '').toString().trim();
  if (!userId && !name) return res.status(400).json({ error: 'Provide userId or name' });

  if (userId) {
    const current = await getSettings(userId);
    current.rainbetName = rainbetName;
    await saveSettings(userId, current);
    return res.json({ ok: true, scope: 'userId', userId, rainbetName });
  }

  // Name-only path: create or update a synthetic entry so the by-name lookup will find it later.
  const syntheticId = `manual:${name.toLowerCase()}`;
  const current = await getSettings(syntheticId);
  current.rainbetName       = rainbetName;
  current.discordDisplayName = name;     // makes /api/settings/by-name/:name match this row
  current.discordUsername    = name;
  await saveSettings(syntheticId, current);
  res.json({ ok: true, scope: 'name', name, syntheticId, rainbetName });
});



// Resolve a member name (Discord username/displayName) to an existing settings userId.
// Returns null if no row matches — caller may fall back to a synthetic manual: id.
// Uses the same matching rules as GET /api/settings/by-name/:name.
async function resolveUserIdByName(name) {
  const search = (name || '').toLowerCase().trim();
  if (!search) return null;
  const searchNoSp = search.replace(/\s+/g, '');
  let rows = [];
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
      rows = r.rows.map(row => ({ userId: row.user_id, ...row.settings }));
    } catch (e) { console.error('[settings] resolveUserIdByName pg error:', e.message); }
  }
  if (!rows.length) {
    rows = Object.entries(userSettings).map(([uid, s]) => ({ userId: uid, ...s }));
  }
  // Prefer real Discord-id rows (17-19 digit ids) over synthetic manual: rows so we keep
  // identity attached to the real account when both happen to exist.
  rows.sort((a, b) => {
    const aReal = /^\d{17,19}$/.test(a.userId) ? 0 : 1;
    const bReal = /^\d{17,19}$/.test(b.userId) ? 0 : 1;
    return aReal - bReal;
  });
  const match = rows.find(s => {
    const candidates = [
      (s.discordUsername    || '').toLowerCase().trim(),
      (s.discordDisplayName || '').toLowerCase().trim(),
    ].filter(Boolean);
    const noSp = candidates.map(c => c.replace(/\s+/g, ''));
    for (const c of candidates.concat(noSp)) {
      if (!c) continue;
      if (c === search || c === searchNoSp) return true;
      if (c.startsWith(search) || search.startsWith(c)) return true;
    }
    return false;
  });
  return match ? match.userId : null;
}

// POST /api/admin/set-user-field — let an admin manually set a per-user identity field
// (rainbetName or twitchName) for someone else. Accepts either { userId, field, value } or
// { name, field, value }. Name-only path first tries to resolve to an existing settings row
// so writes hit the same record reads find; falls back to a synthetic manual: id when missing.
app.post('/api/admin/set-user-field', requireAdmin, async (req, res) => {
  const field = String(req.body?.field || '').trim();
  if (!['rainbetName', 'twitchName'].includes(field))
    return res.status(400).json({ error: "field must be 'rainbetName' or 'twitchName'" });
  const value = String(req.body?.value || '').trim().slice(0, 64);
  if (!value) return res.status(400).json({ error: 'value required' });
  const userId = (req.body?.userId || '').toString().trim();
  const name   = (req.body?.name   || '').toString().trim();
  if (!userId && !name) return res.status(400).json({ error: 'Provide userId or name' });

  if (userId) {
    const current = await getSettings(userId);
    current[field] = value;
    await saveSettings(userId, current);
    return res.json({ ok: true, scope: 'userId', userId, field, value });
  }

  const resolvedId = await resolveUserIdByName(name);
  if (resolvedId) {
    const current = await getSettings(resolvedId);
    current[field] = value;
    await saveSettings(resolvedId, current);
    return res.json({ ok: true, scope: 'resolved', name, userId: resolvedId, field, value });
  }

  const syntheticId = `manual:${name.toLowerCase()}`;
  const current = await getSettings(syntheticId);
  current[field]              = value;
  current.discordDisplayName  = current.discordDisplayName || name;
  current.discordUsername     = current.discordUsername    || name;
  await saveSettings(syntheticId, current);
  res.json({ ok: true, scope: 'name', name, syntheticId, field, value });
});

// POST /api/admin/set-preferred-slots — admin sets another user's preferred-slots list.
// Body: { userId?, name?, slots: [{name, thumb, slug, provider}, ...] }
// When only `name` is provided, uses synthetic `manual:<lowercased>` id so by-name lookup works.
app.post('/api/admin/set-preferred-slots', requireAdmin, async (req, res) => {
  const slots = Array.isArray(req.body?.slots) ? req.body.slots : null;
  if (!slots) return res.status(400).json({ error: 'slots array required' });
  // Sanitize: keep up to 50 slots, normalize fields, drop empties.
  const cleaned = slots
    .filter(s => s && typeof s === 'object' && s.name)
    .slice(0, 50)
    .map(s => ({
      name:     String(s.name).slice(0, 120),
      thumb:    s.thumb    ? String(s.thumb).slice(0, 500) : null,
      slug:     s.slug     ? String(s.slug).slice(0, 200)  : null,
      provider: s.provider ? String(s.provider).slice(0, 80) : null,
    }));
  const userId = (req.body?.userId || '').toString().trim();
  const name   = (req.body?.name   || '').toString().trim();
  if (!userId && !name) return res.status(400).json({ error: 'Provide userId or name' });

  if (userId) {
    const current = await getSettings(userId);
    current.preferredSlots = cleaned;
    await saveSettings(userId, current);
    return res.json({ ok: true, scope: 'userId', userId, count: cleaned.length });
  }

  const resolvedId = await resolveUserIdByName(name);
  if (resolvedId) {
    const current = await getSettings(resolvedId);
    current.preferredSlots = cleaned;
    await saveSettings(resolvedId, current);
    return res.json({ ok: true, scope: 'resolved', name, userId: resolvedId, count: cleaned.length });
  }

  const syntheticId = `manual:${name.toLowerCase()}`;
  const current = await getSettings(syntheticId);
  current.preferredSlots     = cleaned;
  current.discordDisplayName = current.discordDisplayName || name;
  current.discordUsername    = current.discordUsername    || name;
  await saveSettings(syntheticId, current);
  res.json({ ok: true, scope: 'name', name, syntheticId, count: cleaned.length });
});

const ticketHits = new Map(); // per-IP ticket timestamps for rate limiting
app.post('/api/tickets', async (req, res) => {
  const { username, issue, type } = req.body;

  if (!RESEND_API_KEY) return res.status(500).json({error:'RESEND_API_KEY not configured on the server'});
  if (TICKET_EMAILS.length === 0) return res.status(500).json({error:'No ticket recipients configured'});

  // Length caps + per-IP throttle to prevent inbox / Resend-quota spam.
  if (String(issue||'').length > 5000 || String(username||'').length > 120 || String(type||'').length > 40)
    return res.status(400).json({error:'Ticket content too long'});
  const tip = req.ip || 'unknown';
  const tnow = Date.now();
  const recentTickets = (ticketHits.get(tip) || []).filter(t => tnow - t < 10*60*1000);
  if (recentTickets.length >= 5) return res.status(429).json({error:'Too many tickets — please try again in a few minutes'});
  recentTickets.push(tnow); ticketHits.set(tip, recentTickets);

  const safe = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const from = safe(username || 'Anonymous');
  const kind = safe(type || 'General');
  const body = safe(issue || '(no message)').replace(/\n/g,'<br>');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0e0e10; color: #efeff1; border-radius: 8px;">
      <div style="border-left: 3px solid #9146ff; padding-left: 14px; margin-bottom: 20px;">
        <div style="font-size: 11px; color: #adadb8; letter-spacing: 0.12em; text-transform: uppercase;">New CommunityHunts ticket</div>
        <div style="font-size: 20px; font-weight: 700; margin-top: 4px;">${kind}</div>
      </div>
      <div style="background: #18181b; border-radius: 6px; padding: 16px 18px; margin-bottom: 16px;">
        <div style="font-size: 12px; color: #adadb8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px;">From</div>
        <div style="font-size: 15px; font-weight: 600;">${from}</div>
      </div>
      <div style="background: #18181b; border-radius: 6px; padding: 16px 18px;">
        <div style="font-size: 12px; color: #adadb8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">Message</div>
        <div style="font-size: 14px; line-height: 1.6; color: #efeff1;">${body}</div>
      </div>
      <div style="font-size: 11px; color: #7c7c84; margin-top: 18px; text-align: center;">
        ${new Date().toISOString()}
      </div>
    </div>
  `;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: TICKET_FROM,
        to: TICKET_EMAILS,
        subject: `🎫 CommunityHunts Ticket — ${type||'General'} (from ${username||'Anonymous'})`,
        reply_to: username && username.includes('@') ? username : undefined,
        html
      })
    });
    if (!r.ok) {
      const detail = await r.text().catch(()=>'');
      console.error('[ticket] Resend rejected:', r.status, detail);
      return res.status(500).json({error:`Resend returned ${r.status}`, detail});
    }
    const data = await r.json().catch(()=>({}));
    console.log(`[ticket] emailed to ${TICKET_EMAILS.join(', ')} — id ${data.id || '(no id)'}`);
    res.json({ ok: true, via: 'email', recipients: TICKET_EMAILS.length });
  } catch (e) {
    console.error('[ticket] email delivery failed:', e.message);
    res.status(500).json({error:'Failed to send ticket email', detail: e.message});
  }
});

// ── External integrations (Twitch live, leaderboard, Discord) ──────
// Logic lives in lib/integrations.js; route declarations stay here and delegate.
const integrations = require('./lib/integrations');
// Poll each active tenant's Twitch channel. Runs after tenants load.
function startPolling() { integrations.startTenantPolling(io, tenants.getAllTenants()); }
// initTenants() is async; give it a beat, then start polling (Bean is in cache immediately anyway).
setTimeout(startPolling, 3000);

app.get('/api/bean-live', (req, res) => res.json(integrations.getLiveStatus(req.tenant.slug)));

// Active tenant's public branding — NO secrets (bot tokens, channel ids excluded).
app.get('/api/tenant-config', (req, res) => {
  const t = req.tenant;
  res.json({
    slug: t.slug, displayName: t.displayName,
    branding: t.branding || {},
    leaderboardUrl: !!t.leaderboardUrl,   // boolean: does a leaderboard exist?
    twitchChannel: t.twitchChannel || null,
  });
});

// Directory for the platform home — minimal public fields per tenant, incl. member count.
app.get('/api/tenants', async (req, res) => {
  const counts = await memberships.getMemberCounts();
  res.json(tenants.getAllTenants().filter(t => t.isActive).map(t => ({
    slug: t.slug, displayName: t.displayName,
    accent: (t.branding || {}).accent || null,
    twitchChannel: t.twitchChannel || null,
    memberCount: counts[t.id] || 0,
  })));
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    res.json(await integrations.getLeaderboard(req.tenant));
  } catch (e) {
    console.error('[leaderboard] proxy error:', e.message);
    // Serve stale cache if we have it, so a transient upstream blip doesn't blank the panel.
    const stale = integrations.getLeaderboardCache(req.tenant.slug);
    if (stale) return res.json(stale);
    res.status(502).json({ error: 'leaderboard unavailable' });
  }
});

// Import slot calls from last 20 mins — only from equity members of the user's hunt.
app.get('/api/discord/import-calls', requireAuth, async (req, res) => {
  try {
    const hunt = hunts[req.user.id];
    if (!hunt) return res.status(404).json({ error: 'No active hunt' });
    res.json(await integrations.importCalls(hunt, normalizeSlot, req.tenant));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse VIP winners from Discord — finds latest results message and extracts names.
app.get('/api/discord/parse-winners', requireAuth, async (req, res) => {
  try {
    res.json(await integrations.parseWinners(req.tenant));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Slot Autocomplete ─────────────────────────────────────────────
let slotCache = { games: [], thumbMap: {}, fetchedAt: 0 };

// Provider prefixes used in Rainbet slugs (sorted by length desc to match longest first)
const RAINBET_PROVIDERS = [
  'big-time-gaming','massive-studios','backseat-gaming','bullshark-games',
  'foxhound-games','kitsune-studios','pineapple-play','print-studios',
  'pragmatic-play','nownow-gaming','clutch-gaming','jinx-gaming',
  'relax-gaming','red-tiger','playn-go','play-n-go','peter-sons',
  'shady-lady','trusty-gaming','elk-studios','iron-dog','push-gaming',
  'blueprint','spinomenal','thunderkick','yggdrasil','quickspin',
  'wazdan','hacksaw','nolimit','playngo','bgaming','popiplay',
  'voltent','habanero','endorphina','betsoft','1spin4win','pgsoft',
  'mascot','penguin','amigo','3-oaks','belatra','retro','platipus',
  'avatarux','zillion','clawbuster','truelab','slotmill','fantasma',
  'isoftbet','netent','ace-roll','onetouch','gameart','gamomat',
].sort((a, b) => b.length - a.length);

// Maps internal provider IDs to Rainbet's URL prefix format
const PROVIDER_URL_MAP = {
  'pragmatic-play':'pragmatic-play','playngo':'play-n-go','play-n-go':'play-n-go',
  'hacksaw':'hacksaw','hacksaw-gaming':'hacksaw',
  'nolimit':'nolimit','nolimit-city':'nolimit',
  'blueprint':'blueprint','blueprint-gaming':'blueprint',
  'relax':'relax','relax-gaming':'relax',
};

function rainbetExtractProvider(rainbetSlug) {
  for (const p of RAINBET_PROVIDERS) {
    if (rainbetSlug.startsWith(p + '-')) {
      return { provider: p, slug: rainbetSlug.slice(p.length + 1) };
    }
  }
  // Couldn't parse — use first segment as provider
  const idx = rainbetSlug.indexOf('-');
  if (idx > 0) return { provider: rainbetSlug.slice(0, idx), slug: rainbetSlug.slice(idx + 1) };
  return { provider: '', slug: rainbetSlug };
}

// Load pre-scraped Rainbet slot list (authoritative source, ~6700 slots)
let RAINBET_SLOTS = [];
const RAINBET_SLOTS_FILE = path.join(__dirname, 'rainbet_slots.json');
try {
  if (fs.existsSync(RAINBET_SLOTS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(RAINBET_SLOTS_FILE, 'utf8'));
    // Expected format: array of {name, rainbetSlug, thumb}
    // Normalize and URL-encode the path portion of thumb (filenames have spaces)
    RAINBET_SLOTS = raw.map(s => {
      const { provider, slug } = rainbetExtractProvider(s.rainbetSlug || '');
      let thumb = s.thumb || null;
      if (thumb) {
        // Re-encode any unsafe characters in the path
        const match = thumb.match(/^(https?:\/\/[^/]+)(\/.*)$/);
        if (match) {
          const [, origin, path] = match;
          thumb = origin + path.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
        }
      }
      return { name: s.name, slug, provider, rainbetSlug: s.rainbetSlug, thumb };
    }).filter(s => s.name && s.thumb);
    console.log(`[slots] Loaded ${RAINBET_SLOTS.length} slots from rainbet_slots.json`);
  } else {
    console.log('[slots] rainbet_slots.json not found, using slot.report only');
  }
} catch(e) { console.error('[slots] Failed to load rainbet_slots.json:', e.message); }

// Hardcoded thumbnail overrides for slots with non-standard naming
const EXTRA_THUMBS = {
  'fire-in-the-hole-xbomb': 'https://cdn.softswiss.net/i/s4/nolimit/FireInTheHolexBomb.webp',
  'dog-house-megaways':      'https://cdn.softswiss.net/i/s4/pragmatic/TheDogHouseMegaways.webp',
  'book-of-dead':            'https://cdn.softswiss.net/i/s4/playngo/BookofDead.webp',
  'the-jack-rose':           'https://cdn.softswiss.net/i/s4/hacksaw/TheJackandRose.webp',
  'junkyard-kings-2':        'https://cdn.softswiss.net/i/s4/hacksaw/JunkyardKings2.webp',
  'rusty-and-curly':         'https://cdn.softswiss.net/i/s4/hacksaw/RustyAndCurly.webp',
  'hop-n-pop':               'https://cdn.softswiss.net/i/s4/hacksaw/HopnPop.webp',
  'san-quentin-xways':       'https://cdn.softswiss.net/i/s4/nolimit/SanQuentinXWays.webp',
};

// Load pre-verified softswiss CDN hits (tested at build time, ~1900 slots)
let SOFTSWISS_HITS = {};
const SOFTSWISS_HITS_FILE = path.join(__dirname, 'softswiss_hits.json');
try {
  if (fs.existsSync(SOFTSWISS_HITS_FILE)) {
    SOFTSWISS_HITS = JSON.parse(fs.readFileSync(SOFTSWISS_HITS_FILE, 'utf8'));
    console.log(`[slots] Loaded ${Object.keys(SOFTSWISS_HITS).length} pre-verified softswiss thumbs`);
  }
} catch(e) { console.error('[slots] Failed to load softswiss hits:', e.message); }

function toPascal(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// Only show slots from providers available on Rainbet/crypto casinos
const RELEVANT_PROVIDERS = new Set([
  'pragmatic-play', 'playngo', 'hacksaw-gaming', 'elk-studios',
  'red-tiger', 'relax-gaming', 'quickspin', 'blueprint-gaming',
  'nolimit-city', 'bgaming', 'thunderkick', 'yggdrasil',
  'push-gaming', 'netent', 'isoftbet', 'gameart', 'wazdan',
  'big-time-gaming', 'iron-dog-studio', 'spinomenal',
  // slot.report reviewed providers (hacksaw sub-labels etc.)
  'bullshark-games', 'backseat-gaming', 'print-studios',
  'nownow-gaming', 'trusty-gaming', 'kitsune-studios',
  'ace-roll', 'foxhound-games', 'jinx-gaming', 'pineapple-play',
]);

async function getSlotGames() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (slotCache.games.length && Date.now() - slotCache.fetchedAt < ONE_HOUR) {
    return slotCache;
  }
  try {
    const [gamesRes, thumbRes] = await Promise.all([
      fetch('https://slot.report/api/v1/slots.json'),
      fetch('https://slot.report/data/slots-cards.js')
    ]);
    const gamesData = await gamesRes.json();
    const thumbText = await thumbRes.text();

    // Build verified thumb map AND reviewed slug set (these are the popular slots)
    const thumbMap = {};
    const reviewedSlugs = new Set();
    const thumbMatch = thumbText.match(/var SLOT_DATA=([\s\S]*?]);/);
    if (thumbMatch) {
      try {
        const reviewed = JSON.parse(thumbMatch[1]);
        reviewed.forEach(s => {
          if (s.slug && s.thumbnail) {
            thumbMap[s.slug] = `https://slot.report${s.thumbnail.split('?')[0]}`;
            reviewedSlugs.add(s.slug);
          }
        });
        console.log(`[slots] Loaded ${reviewedSlugs.size} reviewed thumbnails`);
      } catch(e) { console.error('[slots] Failed to parse slots-cards.js:', e.message); }
    }

    // Hardcoded extra thumbs for naming exceptions
    const EXTRA_THUMBS_LOCAL = {
      'fire-in-the-hole-xbomb': 'https://cdn.softswiss.net/i/s4/nolimit/FireInTheHolexBomb.webp',
      'dog-house-megaways':      'https://cdn.softswiss.net/i/s4/pragmatic/TheDogHouseMegaways.webp',
      'book-of-dead':            'https://cdn.softswiss.net/i/s4/playngo/BookofDead.webp',
      'the-jack-rose':           'https://cdn.softswiss.net/i/s4/hacksaw/TheJackandRose.webp',
      'junkyard-kings-2':        'https://cdn.softswiss.net/i/s4/hacksaw/JunkyardKings2.webp',
      'rusty-and-curly':         'https://cdn.softswiss.net/i/s4/hacksaw/RustyAndCurly.webp',
      'hop-n-pop':               'https://cdn.softswiss.net/i/s4/hacksaw/HopnPop.webp',
      'san-quentin-xways':       'https://cdn.softswiss.net/i/s4/nolimit/SanQuentinXWays.webp',
    };
    Object.entries(EXTRA_THUMBS_LOCAL).forEach(([slug, url]) => {
      if (!thumbMap[slug]) thumbMap[slug] = url;
    });

    // Filter to relevant providers only, sort reviewed slots first
    const allGames = (gamesData.results || []).filter(s => s.name);

    // Only include slots that are confirmed on Rainbet:
    // - Have a confirmed thumbnail (Rainbet CDN, Softswiss CDN, or scraped from provider sites)
    // - This filters ~2600 confirmed Rainbet slots from the full ~6000 slot list
    const relevant = allGames.filter(g =>
      thumbMap[g.slug] || SOFTSWISS_HITS[g.slug] || reviewedSlugs.has(g.slug)
    );

    // Deduplicate by slug (keep first occurrence)
    const seenSlugs = new Set();
    const deduped = relevant.filter(g => {
      if (seenSlugs.has(g.slug)) return false;
      seenSlugs.add(g.slug);
      return true;
    });

    deduped.sort((a, b) => {
      const aR = reviewedSlugs.has(a.slug), bR = reviewedSlugs.has(b.slug);
      if (aR && !bR) return -1;
      if (!aR && bR) return 1;
      return a.name.localeCompare(b.name);
    });

    slotCache.games     = deduped;
    slotCache.thumbMap  = thumbMap;
    slotCache.fetchedAt = Date.now();
    console.log(`[slots] Cached ${relevant.length} relevant slots (from ${allGames.length} total)`);
  } catch(e) {
    console.error('[slots] Failed to fetch slot list:', e.message);
  }
  return slotCache;
}

// Pre-fetch on startup
getSlotGames().catch(() => {});

// Image proxy — serves CORS-blocked thumbnails (e.g. pragmaticplay.com) through our backend
const imgProxyCache = new Map(); // url -> {buf, ct, at}
const IMG_PROXY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const ALLOWED_IMG_HOSTS = ['www.pragmaticplay.com', 'pragmaticplay.com', 'cdn.softswiss.net', 'cdn.rainbet.com', 'slot.report', 'www.thunderkick.com', 'static.wixstatic.com'];

app.get('/api/img-proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const parsed = new URL(url);
    if (!ALLOWED_IMG_HOSTS.includes(parsed.hostname)) {
      return res.status(403).json({ error: 'Host not allowed' });
    }
    // Check cache
    const cached = imgProxyCache.get(url);
    if (cached && Date.now() - cached.at < IMG_PROXY_TTL) {
      res.set('Content-Type', cached.ct);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('Access-Control-Allow-Origin', '*');
      return res.send(cached.buf);
    }
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' } });
    if (!resp.ok) return res.status(resp.status).end();
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
    const buf = Buffer.from(await resp.arrayBuffer());
    imgProxyCache.set(url, { buf, ct, at: Date.now() });
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/slots/search', async (req, res) => {
  const q     = (req.query.q || '').toLowerCase().trim();
  const limit = parseInt(req.query.limit) || 20;

  // Build full mapped list once and cache it
  if (!getSlotGames._mappedCache) {
    // Rainbet scraped slots only (authoritative; ~6700 with thumbnails)
    getSlotGames._mappedCache = RAINBET_SLOTS.map(s => ({
      name: s.name,
      slug: s.slug,
      provider: s.provider,
      rainbetSlug: s.rainbetSlug,
      thumb: s.thumb,
    }));
    console.log(`[slots] Built mapped cache: ${getSlotGames._mappedCache.length} Rainbet slots`);
  }

  const pool = getSlotGames._mappedCache;
  const filtered = q.length >= 2
    ? pool.filter(g => g.name.toLowerCase().includes(q))
    : pool;

  const results = filtered
    .slice()
    .sort((a, b) => {
      if (q.length >= 2) {
        const aStarts = a.name.toLowerCase().startsWith(q);
        const bStarts = b.name.toLowerCase().startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
      }
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);

  res.json(results);
});

app.get('/api/health', (req, res) => res.json({ok:true}));

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
