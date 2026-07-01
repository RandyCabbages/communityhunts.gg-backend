// Tenant-mod management: per-community Mod role, DB-backed via tenant_roles (role='community_mod').
// Assigned ONLY by platform Owners (never tenant admins, never self-service). Mirrors the
// platform-admins pattern in routes/admin.routes.js, but scoped to req.tenant instead of global.
//
//   GET    /api/admin/mods       — list current tenant's mods (admin OR mod — requireAdmin covers both)
//   POST   /api/admin/mods       — add a mod to req.tenant (platform admin only)
//   DELETE /api/admin/mods/:id   — remove a mod from req.tenant (platform admin only)

const express = require('express');

module.exports = function modsRoutes(deps) {
  const { requireAuth, requireAdmin, requirePlatformAdmin, tenants, pgPool } = deps;
  const router = express.Router();

  // List the current tenant's mods. Viewable by tenant admins AND mods (requireAdmin covers both
  // post reqIsMod fold-in), but edit controls are gated client-side (and server-side below) on
  // isPlatformAdmin.
  router.get('/api/admin/mods', requireAuth, requireAdmin, async (req, res) => {
    try {
      const ids = await tenants.listTenantMods(req.tenant.id);
      let rows = ids.map(discordId => ({ discordId, source: 'db' }));
      if (pgPool && rows.length) {
        try {
          const r = await pgPool.query(
            `SELECT user_id, display_name, avatar FROM known_users WHERE user_id = ANY($1)`, [ids]);
          const byId = {};
          for (const u of r.rows) byId[u.user_id] = u;
          rows = rows.map(row => ({
            ...row,
            displayName: byId[row.discordId]?.display_name || null,
            avatar: byId[row.discordId]?.avatar || null,
          }));
        } catch (e) { console.error('[mods] enrich failed:', e.message); }
      }
      res.json(rows);
    } catch (e) {
      console.error('[mods] list failed:', e.message);
      res.status(500).json({ error: 'Failed to list mods' });
    }
  });

  // Add a mod to the current tenant. Owner-only.
  router.post('/api/admin/mods', requireAuth, requirePlatformAdmin, async (req, res) => {
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({ error: 'Valid Discord ID required' });
    if (tenants.isPlatformOwnerId(discordId)) return res.status(400).json({ error: 'Owner is already admin everywhere' });
    try {
      await tenants.addTenantMod(req.tenant.id, discordId);
      res.json({ ok: true });
    } catch (e) {
      console.error('[mods] add failed:', e.message);
      res.status(500).json({ error: 'Failed to add mod' });
    }
  });

  // Remove a mod from the current tenant. Owner-only.
  router.delete('/api/admin/mods/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      await tenants.removeTenantMod(req.tenant.id, id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[mods] remove failed:', e.message);
      res.status(500).json({ error: 'Failed to remove mod' });
    }
  });

  return router;
};
