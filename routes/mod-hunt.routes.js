// Mod hunt + Affiliate hunt routes. Two shared hunts per community (not per-user), keyed by
// modHuntKey(tenantId)/affiliateHuntKey(tenantId):
//   __mod_hunt__       — Bean's tenant only (legacy fixed key — OBS overlay link never changes)
//   __mod_hunt__:<id>  — every other tenant, namespaced so communities' mod hunts don't collide
// (same pattern for __affiliate_hunt__). All gated by requireMod. Thin router; mounted from the
// server.js composition root.
//
// hunts/archive are persistence-owned singletons (by reference, never reassigned — only mutated).
// Behavior unchanged from the inline routes; every hunt:update goes through publicHuntView.

const express = require('express');

module.exports = function modHuntRoutes(deps) {
  const {
    hunts, archive, io, persistHunts, archiveHunt,
    requireMod, modHuntKey, affiliateHuntKey, tenants,
    uid, touch, publicHuntView, rejectBadHuntInput,
  } = deps;
  const router = express.Router();

  // Resolve the display name shown in Bean's-Hunt/Affiliate-Hunt equity from the tenant's own
  // branding, instead of hardcoding 'Bean'. Bean's tenant has branding.hostName === 'Bean', so
  // this naturally resolves to the same value for Bean — zero behavior change for the existing
  // production tenant.
  function hostNameFor(tenantId) {
    const t = tenants.getTenantBySlug(tenantId) || tenants.getTenantBySlug('bean');
    return t?.branding?.hostName || t?.displayName || 'Bean';
  }

  // ── Mod hunt — private solo hunt run jointly by a community's Mods ────
  // Stored under modHuntKey(tenantId) so Bean's OBS overlay link never changes.
  // Never appears on Hub or archive listings.
  function emptyModHunt(tenantId) {
    return {
      user: { id: modHuntKey(tenantId), displayName: hostNameFor(tenantId), avatar: null },
      huntId: uid(), isLive: false, startedAt: null, archivedAt: null,
      tenantId: tenantId || 'bean',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType: 'solo', bonuses: [], equity: [{ id: 'bean_auto', name: hostNameFor(tenantId), amount: 0, isRollWinner: false }],
      calls: [], invitedEditors: [], callLimit: 0, huntMode: 'hunting',
      roundRobin: false, lockTop4: false, currency: 'USD', publicCalls: false, publicCallsPin: null,
    };
  }

  router.get('/api/mod-hunt', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    res.json(hunts[key] || null);
  });

  router.put('/api/mod-hunt', requireMod, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    const key = modHuntKey(req.tenant.id);
    if (!hunts[key]) hunts[key] = emptyModHunt(req.tenant.id);
    const { bonuses, equity, calls, callLimit, huntMode, roundRobin, lockTop4, currency, currentSlot, manualOrder } = req.body;
    if (bonuses    !== undefined) hunts[key].bonuses    = bonuses;
    if (equity     !== undefined) hunts[key].equity     = equity;
    if (calls      !== undefined) hunts[key].calls      = calls;
    if (callLimit  !== undefined) hunts[key].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[key].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[key].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[key].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[key].currency   = currency;
    if (currentSlot !== undefined) hunts[key].currentSlot = currentSlot;
    if (manualOrder !== undefined) hunts[key].manualOrder = manualOrder;
    hunts[key].huntType = 'solo';
    touch(key);
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(hunts[key]));
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/golive', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    if (!hunts[key]) hunts[key] = emptyModHunt(req.tenant.id);
    hunts[key].isLive     = true;
    hunts[key].startedAt  = new Date().toISOString();
    hunts[key].updatedAt  = new Date().toISOString();
    hunts[key].archivedAt = null;
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(hunts[key]));
    res.json({ ok: true });
  });

  // Stop broadcasting without ending/archiving — host can go live again. (See /end for the lock path.)
  router.post('/api/mod-hunt/offline', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      persistHunts();
      io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(h));
    }
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/end', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.archivedAt) h.archivedAt = new Date().toISOString();
      persistHunts();
      io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(h));
    }
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/reopen', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const h = hunts[key];
    if (!h) return res.status(404).json({ error: 'No mod hunt' });
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(h));
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/reset', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const old = hunts[key];
    if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
      if (!old.archivedAt) old.archivedAt = new Date().toISOString();
      archiveHunt(old);
    }
    hunts[key] = emptyModHunt(req.tenant.id);
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(hunts[key]));
    res.json({ ok: true });
  });

  router.get('/api/mod-hunt/history', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const modArchived = archive.filter(h => h.user?.id === key);
    res.json(modArchived.map(h => ({
      archivedAt: h.archivedAt,
      bonuses: h.bonuses || [],
      equity: h.equity || [],
      huntMode: h.huntMode,
      lockTop4: h.lockTop4 ?? false,
      startedAt: h.startedAt,
      createdAt: h.createdAt,
      totalWon: (h.bonuses || []).reduce((s, b) => s + (b.win || 0), 0),
      totalBet: (h.bonuses || []).reduce((s, b) => s + (b.bet || 0), 0),
      bonusCount: (h.bonuses || []).length,
    })));
  });

  // ── Affiliate hunt — VIP-style hunt run jointly by a community's Mods ──
  function emptyAffiliateHunt(tenantId) {
    return {
      user: { id: affiliateHuntKey(tenantId), displayName: hostNameFor(tenantId), avatar: null },
      huntId: uid(), isLive: false, startedAt: null, archivedAt: null,
      tenantId: tenantId || 'bean',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType: 'vip', bonuses: [],
      equity: [
        { id: 'bean_auto', name: hostNameFor(tenantId), amount: 1000, isRollWinner: false },
      ],
      calls: [], invitedEditors: [], callLimit: 10, huntMode: 'hunting',
      roundRobin: true, lockTop4: false, currency: 'USD', publicCalls: false, publicCallsPin: null,
    };
  }

  router.get('/api/affiliate-hunt', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    res.json(hunts[key] || null);
  });

  router.put('/api/affiliate-hunt', requireMod, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    const key = affiliateHuntKey(req.tenant.id);
    if (!hunts[key]) hunts[key] = emptyAffiliateHunt(req.tenant.id);
    const { bonuses, equity, calls, callLimit, huntMode, roundRobin, lockTop4, currency, currentSlot, manualOrder } = req.body;
    if (bonuses    !== undefined) hunts[key].bonuses    = bonuses;
    if (equity     !== undefined) hunts[key].equity     = equity;
    if (calls      !== undefined) hunts[key].calls      = calls;
    if (callLimit  !== undefined) hunts[key].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[key].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[key].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[key].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[key].currency   = currency;
    if (currentSlot !== undefined) hunts[key].currentSlot = currentSlot;
    if (manualOrder !== undefined) hunts[key].manualOrder = manualOrder;
    hunts[key].huntType = 'vip';
    touch(key);
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(hunts[key]));
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/golive', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    if (!hunts[key]) hunts[key] = emptyAffiliateHunt(req.tenant.id);
    hunts[key].isLive     = true;
    hunts[key].startedAt  = new Date().toISOString();
    hunts[key].updatedAt  = new Date().toISOString();
    hunts[key].archivedAt = null;
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(hunts[key]));
    res.json({ ok: true });
  });

  // Stop broadcasting without ending/archiving — host can go live again. (See /end for the lock path.)
  router.post('/api/affiliate-hunt/offline', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      persistHunts();
      io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(h));
    }
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/end', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.archivedAt) h.archivedAt = new Date().toISOString();
      persistHunts();
      io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(h));
    }
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/reopen', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const h = hunts[key];
    if (!h) return res.status(404).json({ error: 'No affiliate hunt' });
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(h));
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/reset', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const old = hunts[key];
    if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
      if (!old.archivedAt) old.archivedAt = new Date().toISOString();
      archiveHunt(old);
    }
    hunts[key] = emptyAffiliateHunt(req.tenant.id);
    persistHunts();
    io.to(`hunt:${key}`).emit('hunt:update', publicHuntView(hunts[key]));
    res.json({ ok: true });
  });

  router.get('/api/affiliate-hunt/history', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const affArchived = archive.filter(h => h.user?.id === key);
    res.json(affArchived.map(h => ({
      archivedAt: h.archivedAt,
      bonuses: h.bonuses || [],
      equity: h.equity || [],
      huntMode: h.huntMode,
      lockTop4: h.lockTop4 ?? false,
      startedAt: h.startedAt,
      createdAt: h.createdAt,
      totalWon: (h.bonuses || []).reduce((s, b) => s + (b.win || 0), 0),
      totalBet: (h.bonuses || []).reduce((s, b) => s + (b.bet || 0), 0),
      bonusCount: (h.bonuses || []).length,
    })));
  });

  return router;
};
