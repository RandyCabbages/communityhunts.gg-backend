// Authentication + authorization: identity helpers, HMAC-signed token fallback,
// ID-based admin/VIP gating, hunt-permission checks, tenant resolution, and the
// Express gate middlewares. Extracted from server.js (de-slop refactor, 2026-06-20).
// BEHAVIOR UNCHANGED — this is a pure move. Gating stays ID-based, never display name.
//
// DI: initAuth(deps) injects config + collaborators that used to be in server.js scope.
// The gate functions only run at request time, so initAuth may be called after the
// middlewares are registered (it just needs to run before the first request).
//
//   deps = {
//     ADMIN_IDS, VIP_IDS,        // env-derived id lists (string[])
//     SESSION_SECRET,            // HMAC key for token sign/verify
//     MULTI_TENANT,              // boolean flag
//     tenants, admins,           // lib modules (PLATFORM_OWNER_ID, isDbAdmin, isTenant*, BEAN_TENANT, getTenantBySlug)
//     hunts,                     // persistence-owned singleton (by reference, read only here)
//     recordKnownUser,           // settings helper (called by the Bearer fallback)
//   }

const crypto = require('crypto');

let ADMIN_IDS = [];
let VIP_IDS = [];
let SESSION_SECRET = '';
let MULTI_TENANT = false;
let tenants = null;
let admins = null;
let hunts = null;
let recordKnownUser = () => {};

function initAuth(deps) {
  ADMIN_IDS       = deps.ADMIN_IDS || [];
  VIP_IDS         = deps.VIP_IDS || [];
  SESSION_SECRET  = deps.SESSION_SECRET || '';
  MULTI_TENANT    = !!deps.MULTI_TENANT;
  tenants         = deps.tenants;
  admins          = deps.admins;
  hunts           = deps.hunts;
  recordKnownUser = deps.recordKnownUser || (() => {});
}

function nameOf(user) { return (user?.displayName || user?.username || '').toLowerCase().trim(); }

function isAdmin(user) {
  // ID-based only — display names are spoofable. Admins live in ADMIN_IDS (env),
  // the platform_admins DB table, or are the hardcoded platform owner.
  if (!user || !user.id) return false;
  return ADMIN_IDS.includes(user.id)
      || user.id === tenants.PLATFORM_OWNER_ID
      || admins.isDbAdmin(user.id);
}
// Platform admin = admin on ALL tenants (owner + env + DB). Distinct from a
// per-tenant community admin (tenant_roles). Used by admin-management endpoints.
function isPlatformAdmin(user) { return isAdmin(user); }
function isVipHost(user) {
  // ID-based only (see isAdmin). VIP hosts — and admins, who are also listed — in VIP_IDS.
  return !!(user && user.id && VIP_IDS.includes(user.id));
}

// ── HMAC-signed auth tokens ────────────────────────────────────────
// Fallback when third-party cookies are blocked (Safari, Brave, etc).
// Token format: base64url(payload) + "." + base64url(hmacSha256(payload))
// Payload: JSON {id, username, displayName, avatar, exp}
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

// Takes `req` (not bare user) so admin status resolves through reqIsAdmin — the SAME
// authority used by /auth/me, requireAdmin, and the admin tabs (platform owner + tenant
// admins + env ADMIN_IDS). Using bare isAdmin(user) here was the bug: the nav showed the
// owner as admin while every hunt they didn't own stayed read-only.
function canEditHunt(req, huntOwnerId) {
  const user = req?.user;
  if (!user) return false;
  if (reqIsAdmin(req)) return true;
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

// ── Gate middlewares ───────────────────────────────────────────────
function requireAuth(req, res, next)  { if (!req.user) return res.status(401).json({error:'Not authenticated'}); next(); }
// Tenant-aware gates: when MULTI_TENANT is on, resolve against req.tenant; else the env-based globals.
// reqIsMod resolves against req.tenant UNCONDITIONALLY — unlike reqIsAdmin/reqIsVipHost, it does
// NOT check MULTI_TENANT first. Mods are a brand-new role with no legacy env-var behavior to
// preserve, and resolveTenant() already guarantees req.tenant is always set (to BEAN_TENANT when
// the flag is off or no slug is sent) — so this is correct in both flag states, and is what makes
// the Mod role work in production today regardless of MULTI_TENANT's value.
function reqIsMod(req) {
  if (isPlatformAdmin(req.user)) return true;   // owner + env + DB admin → mod everywhere
  return tenants.isTenantMod(req.user, req.tenant);
}
// Mods get the same admin-equivalent visibility tenant admins already get (additive only — never
// removes access; the MULTI_TENANT-gated tenant-admin branch below is untouched).
function reqIsAdmin(req) {
  if (isPlatformAdmin(req.user)) return true;               // owner + env + DB → admin everywhere
  if (reqIsMod(req)) return true;                            // mods get admin-equivalent visibility
  return MULTI_TENANT ? tenants.isTenantAdmin(req.user, req.tenant) : false;
}
function reqIsVipHost(req) { if (isPlatformAdmin(req.user)) return true; return MULTI_TENANT ? tenants.isTenantVip(req.user, req.tenant) : (isAdmin(req.user)||isVipHost(req.user)); }
function requireAdmin(req, res, next) { if (!req.user||!reqIsAdmin(req)) return res.status(403).json({error:'Admin only'}); next(); }
function requirePlatformAdmin(req, res, next) {
  if (!req.user || !isPlatformAdmin(req.user)) return res.status(403).json({error:'Platform admin only'});
  next();
}
function requireMod(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!reqIsMod(req)) return res.status(403).json({ error: 'Access denied' });
  next();
}

// ── Tenant resolution + Bearer fallback (global middlewares) ───────
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

// Token-based auth fallback — for browsers that block third-party cookies.
// If req.user wasn't set by passport session, check for Authorization: Bearer <token>
function bearerFallback(req, res, next) {
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
}

module.exports = {
  initAuth,
  nameOf,
  isAdmin, isPlatformAdmin, isVipHost,
  b64url, b64urlDecode, signToken, verifyToken,
  canEditHunt, isEquityMember,
  requireAuth, reqIsAdmin, reqIsVipHost, requireAdmin, requirePlatformAdmin,
  reqIsMod, requireMod,
  resolveTenant, bearerFallback,
};
