// Auth + community-membership routes. Thin router; mounted from the server.js composition
// root AFTER the lib deps (settings/memberships/tenants/auth) exist. The Passport Discord
// strategy itself is configured in server.js (passport.use); these routes consume it.
//
//   GET  /auth/discord                 — start Discord OAuth
//   GET  /auth/discord/callback        — OAuth callback (records user, auto-joins, signs token)
//   GET  /auth/logout                  — clear session
//   GET  /auth/me                      — current user + isAdmin/isVipHost/isPlatformAdmin
//   GET  /api/known-users              — public equity-name autocomplete list
//   GET  /api/my-communities           — tenant slugs the user belongs to
//   POST /api/communities/:slug/join   — join a community
//   POST /api/communities/:slug/leave  — leave a community

const express = require('express');

module.exports = function authRoutes(deps) {
  const {
    passport, FRONTEND_URL, requireAuth,
    reqIsAdmin, reqIsVipHost, reqIsMod, isPlatformAdmin, signToken,
    recordKnownUser, memberships, tenants, pgPool,
  } = deps;
  const router = express.Router();

  router.get('/auth/discord', (req, res, next) => {
    if (req.query.returnTo) req.session.returnTo = req.query.returnTo;
    passport.authenticate('discord')(req, res, next);
  });
  router.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: `${FRONTEND_URL}/?error=auth` }),
    (req, res) => {
      // Record this user as known so they show up in equity-name autocomplete for others
      recordKnownUser(req.user);
      // Auto-join the community they signed in through (Bean today; the slug they arrived via later).
      memberships.joinCommunity(req.user.id, req.tenant.id).catch(() => {});
      const userData = Buffer.from(JSON.stringify({
        id: req.user.id, username: req.user.username,
        displayName: req.user.displayName, avatar: req.user.avatar,
        isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req), isCommunityMod: reqIsMod(req), isPlatformAdmin: isPlatformAdmin(req.user),
        isAffiliate: !!req.user.isAffiliate, isDiscordVip: !!req.user.isDiscordVip, isDiscordMod: !!req.user.isDiscordMod,
      })).toString('base64');
      const returnTo = req.session.returnTo || '/';
      delete req.session.returnTo;
      // Signed token — frontend stores this and sends as Bearer in case cookies are blocked
      const token = signToken(req.user);
      const returnParam = returnTo !== '/' ? `&returnTo=${encodeURIComponent(returnTo)}` : '';
      res.redirect(`${FRONTEND_URL}/?auth=${encodeURIComponent(userData)}&t=${encodeURIComponent(token)}${returnParam}`);
    }
  );
  router.get('/auth/logout', (req, res) => req.logout(() => res.redirect(FRONTEND_URL)));
  router.get('/auth/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    // Anyone who hits /auth/me with a valid session has logged in at some point.
    // Record (or refresh) them in known_users so they show up in equity autocomplete.
    recordKnownUser(req.user);
    // Auto-attribute to the community they're browsing (Bean by default) — idempotent, so a
    // returning user keeps their original join date and this just no-ops after the first time.
    memberships.joinCommunity(req.user.id, req.tenant.id).catch(() => {});
    res.json({ user: { ...req.user, isAdmin: reqIsAdmin(req), isVipHost: reqIsVipHost(req), isCommunityMod: reqIsMod(req), isPlatformAdmin: isPlatformAdmin(req.user),
      isAffiliate: !!req.user.isAffiliate, isDiscordVip: !!req.user.isDiscordVip, isDiscordMod: !!req.user.isDiscordMod } });
  });

  // Public list of known users for equity-name autocomplete.
  // Returns {id, displayName, avatar} for everyone who's ever logged in, sorted by recency.
  router.get('/api/known-users', async (req, res) => {
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
  router.get('/api/my-communities', requireAuth, async (req, res) => {
    res.json({ communities: await memberships.getUserCommunities(req.user.id) });
  });

  // POST /api/communities/:slug/join — join a community (the slug in the path, validated against tenants).
  router.post('/api/communities/:slug/join', requireAuth, async (req, res) => {
    const t = tenants.getTenantBySlug(String(req.params.slug));
    if (!t) return res.status(404).json({ error: 'Unknown community' });
    await memberships.joinCommunity(req.user.id, t.id);
    res.json({ ok: true, communities: await memberships.getUserCommunities(req.user.id) });
  });

  // POST /api/communities/:slug/leave — leave a community.
  router.post('/api/communities/:slug/leave', requireAuth, async (req, res) => {
    const t = tenants.getTenantBySlug(String(req.params.slug));
    if (!t) return res.status(404).json({ error: 'Unknown community' });
    await memberships.leaveCommunity(req.user.id, t.id);
    res.json({ ok: true, communities: await memberships.getUserCommunities(req.user.id) });
  });

  return router;
};
