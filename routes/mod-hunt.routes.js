// Mod hunt + Affiliate hunt routes. Two fixed-key shared hunts (not per-user):
//   __mod_hunt__       — private solo hunt for Bean, managed by mods (OBS overlay link is stable)
//   __affiliate_hunt__ — VIP-style hunt for Bean with $50 roll winners
// All gated by requireModHuntAccess. Thin router; mounted from the server.js composition root.
//
// hunts/archive are persistence-owned singletons (by reference, never reassigned — only mutated).
// Behavior unchanged from the inline routes; every hunt:update goes through publicHuntView.

const express = require('express');

module.exports = function modHuntRoutes(deps) {
  const {
    hunts, archive, io, persistHunts, archiveHunt,
    requireModHuntAccess, MOD_HUNT_ID, AFFILIATE_HUNT_ID,
    uid, touch, publicHuntView, rejectBadHuntInput,
  } = deps;
  const router = express.Router();

  // ── Mod hunt — private solo hunt for Bean, managed by mods ────────
  // Stored under the fixed key MOD_HUNT_ID so the OBS overlay link never changes.
  // Never appears on Hub or archive listings.
  function emptyModHunt(tenantId) {
    return {
      user: { id: MOD_HUNT_ID, displayName: 'Bean', avatar: null },
      huntId: uid(), isLive: false, startedAt: null, archivedAt: null,
      tenantId: tenantId || 'bean',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType: 'solo', bonuses: [], equity: [{ id: 'bean_auto', name: 'Bean', amount: 0, isRollWinner: false }],
      calls: [], invitedEditors: [], callLimit: 0, huntMode: 'hunting',
      roundRobin: false, lockTop4: false, currency: 'USD', publicCalls: false, publicCallsPin: null,
    };
  }

  router.get('/api/mod-hunt', requireModHuntAccess, (req, res) => {
    res.json(hunts[MOD_HUNT_ID] || null);
  });

  router.put('/api/mod-hunt', requireModHuntAccess, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    if (!hunts[MOD_HUNT_ID]) hunts[MOD_HUNT_ID] = emptyModHunt(req.tenant.id);
    const { bonuses, equity, calls, callLimit, huntMode, roundRobin, lockTop4, currency, currentSlot } = req.body;
    if (bonuses    !== undefined) hunts[MOD_HUNT_ID].bonuses    = bonuses;
    if (equity     !== undefined) hunts[MOD_HUNT_ID].equity     = equity;
    if (calls      !== undefined) hunts[MOD_HUNT_ID].calls      = calls;
    if (callLimit  !== undefined) hunts[MOD_HUNT_ID].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[MOD_HUNT_ID].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[MOD_HUNT_ID].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[MOD_HUNT_ID].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[MOD_HUNT_ID].currency   = currency;
    if (currentSlot !== undefined) hunts[MOD_HUNT_ID].currentSlot = currentSlot;
    hunts[MOD_HUNT_ID].huntType = 'solo';
    touch(MOD_HUNT_ID);
    persistHunts();
    io.to(`hunt:${MOD_HUNT_ID}`).emit('hunt:update', publicHuntView(hunts[MOD_HUNT_ID]));
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/golive', requireModHuntAccess, (req, res) => {
    if (!hunts[MOD_HUNT_ID]) hunts[MOD_HUNT_ID] = emptyModHunt(req.tenant.id);
    hunts[MOD_HUNT_ID].isLive     = true;
    hunts[MOD_HUNT_ID].startedAt  = new Date().toISOString();
    hunts[MOD_HUNT_ID].updatedAt  = new Date().toISOString();
    hunts[MOD_HUNT_ID].archivedAt = null;
    persistHunts();
    io.to(`hunt:${MOD_HUNT_ID}`).emit('hunt:update', publicHuntView(hunts[MOD_HUNT_ID]));
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/end', requireModHuntAccess, (req, res) => {
    const h = hunts[MOD_HUNT_ID];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.archivedAt) h.archivedAt = new Date().toISOString();
      persistHunts();
      io.to(`hunt:${MOD_HUNT_ID}`).emit('hunt:update', publicHuntView(h));
    }
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/reopen', requireModHuntAccess, (req, res) => {
    const h = hunts[MOD_HUNT_ID];
    if (!h) return res.status(404).json({ error: 'No mod hunt' });
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    persistHunts();
    io.to(`hunt:${MOD_HUNT_ID}`).emit('hunt:update', publicHuntView(h));
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/reset', requireModHuntAccess, (req, res) => {
    const old = hunts[MOD_HUNT_ID];
    if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
      if (!old.archivedAt) old.archivedAt = new Date().toISOString();
      archiveHunt(old);
    }
    hunts[MOD_HUNT_ID] = emptyModHunt(req.tenant.id);
    persistHunts();
    io.to(`hunt:${MOD_HUNT_ID}`).emit('hunt:update', publicHuntView(hunts[MOD_HUNT_ID]));
    res.json({ ok: true });
  });

  router.get('/api/mod-hunt/history', requireModHuntAccess, (req, res) => {
    const modArchived = archive.filter(h => h.user?.id === MOD_HUNT_ID);
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

  // ── Affiliate hunt — VIP-style hunt for Bean with $50 roll winners ──
  function emptyAffiliateHunt(tenantId) {
    return {
      user: { id: AFFILIATE_HUNT_ID, displayName: 'Bean', avatar: null },
      huntId: uid(), isLive: false, startedAt: null, archivedAt: null,
      tenantId: tenantId || 'bean',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType: 'vip', bonuses: [],
      equity: [
        { id: 'bean_auto', name: 'Bean', amount: 1000, isRollWinner: false },
      ],
      calls: [], invitedEditors: [], callLimit: 10, huntMode: 'hunting',
      roundRobin: true, lockTop4: false, currency: 'USD', publicCalls: false, publicCallsPin: null,
    };
  }

  router.get('/api/affiliate-hunt', requireModHuntAccess, (req, res) => {
    res.json(hunts[AFFILIATE_HUNT_ID] || null);
  });

  router.put('/api/affiliate-hunt', requireModHuntAccess, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    if (!hunts[AFFILIATE_HUNT_ID]) hunts[AFFILIATE_HUNT_ID] = emptyAffiliateHunt(req.tenant.id);
    const { bonuses, equity, calls, callLimit, huntMode, roundRobin, lockTop4, currency, currentSlot } = req.body;
    if (bonuses    !== undefined) hunts[AFFILIATE_HUNT_ID].bonuses    = bonuses;
    if (equity     !== undefined) hunts[AFFILIATE_HUNT_ID].equity     = equity;
    if (calls      !== undefined) hunts[AFFILIATE_HUNT_ID].calls      = calls;
    if (callLimit  !== undefined) hunts[AFFILIATE_HUNT_ID].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[AFFILIATE_HUNT_ID].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[AFFILIATE_HUNT_ID].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[AFFILIATE_HUNT_ID].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[AFFILIATE_HUNT_ID].currency   = currency;
    if (currentSlot !== undefined) hunts[AFFILIATE_HUNT_ID].currentSlot = currentSlot;
    hunts[AFFILIATE_HUNT_ID].huntType = 'vip';
    touch(AFFILIATE_HUNT_ID);
    persistHunts();
    io.to(`hunt:${AFFILIATE_HUNT_ID}`).emit('hunt:update', publicHuntView(hunts[AFFILIATE_HUNT_ID]));
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/golive', requireModHuntAccess, (req, res) => {
    if (!hunts[AFFILIATE_HUNT_ID]) hunts[AFFILIATE_HUNT_ID] = emptyAffiliateHunt(req.tenant.id);
    hunts[AFFILIATE_HUNT_ID].isLive     = true;
    hunts[AFFILIATE_HUNT_ID].startedAt  = new Date().toISOString();
    hunts[AFFILIATE_HUNT_ID].updatedAt  = new Date().toISOString();
    hunts[AFFILIATE_HUNT_ID].archivedAt = null;
    persistHunts();
    io.to(`hunt:${AFFILIATE_HUNT_ID}`).emit('hunt:update', publicHuntView(hunts[AFFILIATE_HUNT_ID]));
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/end', requireModHuntAccess, (req, res) => {
    const h = hunts[AFFILIATE_HUNT_ID];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.archivedAt) h.archivedAt = new Date().toISOString();
      persistHunts();
      io.to(`hunt:${AFFILIATE_HUNT_ID}`).emit('hunt:update', publicHuntView(h));
    }
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/reopen', requireModHuntAccess, (req, res) => {
    const h = hunts[AFFILIATE_HUNT_ID];
    if (!h) return res.status(404).json({ error: 'No affiliate hunt' });
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    persistHunts();
    io.to(`hunt:${AFFILIATE_HUNT_ID}`).emit('hunt:update', publicHuntView(h));
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/reset', requireModHuntAccess, (req, res) => {
    const old = hunts[AFFILIATE_HUNT_ID];
    if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
      if (!old.archivedAt) old.archivedAt = new Date().toISOString();
      archiveHunt(old);
    }
    hunts[AFFILIATE_HUNT_ID] = emptyAffiliateHunt(req.tenant.id);
    persistHunts();
    io.to(`hunt:${AFFILIATE_HUNT_ID}`).emit('hunt:update', publicHuntView(hunts[AFFILIATE_HUNT_ID]));
    res.json({ ok: true });
  });

  router.get('/api/affiliate-hunt/history', requireModHuntAccess, (req, res) => {
    const affArchived = archive.filter(h => h.user?.id === AFFILIATE_HUNT_ID);
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
