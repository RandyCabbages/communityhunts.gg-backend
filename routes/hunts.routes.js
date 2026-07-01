// Public-hunt + my-hunt routes. Thin router; mounted from the server.js composition root.
//   GET    /api/hunts                              — live public hunts (tenant)
//   GET    /api/hunts/archived                     — completed archived hunts (tenant)
//   GET    /api/hunts/:userId/archived/:archivedAt — one archived snapshot (readonly)
//   GET    /api/hunts/:userId                      — one hunt (permission-aware, auto-links viewer)
//   GET    /api/my-hunt                            — caller's own hunt
//   POST   /api/my-hunt/start|golive|offline|end|reopen|reset
//   PUT    /api/my-hunt          DELETE /api/my-hunt  — caller deletes their own hunt (removes it)
//   POST   /api/my-hunt/invite   DELETE /api/my-hunt/invite
//
// ROUTE ORDER IS LOAD-BEARING: /api/hunts/archived and /api/hunts/:userId/archived/:archivedAt
// MUST be declared before /api/hunts/:userId, or the :userId param swallows them. Preserved below.
// hunts/archive are persistence-owned singletons (by reference). hunt:update via publicHuntView.

const express = require('express');

module.exports = function huntsRoutes(deps) {
  const {
    requireAuth, canEditHunt, isEquityMember, reqIsMod,
    hunts, archive, getPublicHunts, getArchivedHunts,
    emitHubUpdate, emitHuntUpdate, publicHuntView, uid, touch,
    persistHunts, archiveHunt, unarchiveHunt, io, rejectBadHuntInput,
  } = deps;
  const router = express.Router();

  // ── Public hunt endpoints ──────────────────────────────────────────
  router.get('/api/hunts',          (req, res) => res.json(getPublicHunts(req.tenant.id)));
  router.get('/api/hunts/archived', (req, res) => res.json(getArchivedHunts(req.tenant.id)));

  // Fetch a specific archived hunt snapshot. One user can have many archived hunts so the
  // archivedAt timestamp is the tiebreaker. Always returned as readonly (canEdit/canAddCalls=false).
  router.get('/api/hunts/:userId/archived/:archivedAt', (req, res) => {
    const { userId, archivedAt } = req.params;
    const found = archive.find(h => h.user?.id === userId && h.archivedAt === archivedAt);
    if (!found) return res.status(404).json({error:'Archived hunt not found'});
    res.json({ ...found, canEdit: false, canAddCalls: false });
  });

  router.get('/api/hunts/:userId', (req, res) => {
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({error:'Hunt not found'});
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
  router.get('/api/my-hunt', requireAuth, (req, res) => res.json(hunts[req.user.id] || null));

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
    // community: always seed the host (creator) so the runner is present even without a
    // starting balance (amount = the balance if given, else 0). Also covers reset, which
    // calls initialEquity('community', …) with no balance.
    return [{ id:'creator_auto', name: userName, amount: balance != null ? balance : 0, isRollWinner: false }];
  }

  router.post('/api/my-hunt/start', requireAuth, (req, res) => {
    const { huntType = 'community', startingBalance, currency } = req.body;
    if (huntType === 'vip' && !reqIsMod(req))
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

  router.post('/api/my-hunt/golive', requireAuth, (req, res) => {
    if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
    hunts[req.user.id].isLive    = true;
    hunts[req.user.id].startedAt = new Date().toISOString();
    hunts[req.user.id].updatedAt = new Date().toISOString();
    hunts[req.user.id].archivedAt= null;
    emitHubUpdate(req.tenant.id); // emitHubUpdate calls persistHunts
    io.to(`hunt:${req.user.id}`).emit('hunt:update', publicHuntView(hunts[req.user.id]));
    res.json({ok:true});
  });

  // Stop broadcasting WITHOUT ending: flip isLive off but leave the hunt unarchived and
  // fully editable, so the host can go live again. (Distinct from /end, which archives + locks.)
  router.post('/api/my-hunt/offline', requireAuth, (req, res) => {
    const h = hunts[req.user.id];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      emitHubUpdate(req.tenant.id); // drop it from the hub's live list; also persists
      io.to(`hunt:${req.user.id}`).emit('hunt:update', publicHuntView(h));
    }
    res.json({ok:true});
  });

  router.post('/api/my-hunt/end', requireAuth, (req, res) => {
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
  router.post('/api/my-hunt/reopen', requireAuth, (req, res) => {
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

  router.post('/api/my-hunt/reset', requireAuth, (req, res) => {
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

  // Delete the caller's own hunt entirely — removes it from the hub. Distinct from /reset (which
  // blanks it but leaves an empty hunt still showing in the hub) and /end (which archives + keeps it
  // as history). To keep results, the client calls /end first (archives a copy), then this.
  router.delete('/api/my-hunt', requireAuth, (req, res) => {
    if (hunts[req.user.id]) {
      delete hunts[req.user.id];
      emitHubUpdate(req.tenant.id); // drops it from the hub list; also persists
    }
    res.json({ok:true});
  });

  router.put('/api/my-hunt', requireAuth, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    if (!hunts[req.user.id]) hunts[req.user.id] = {
      user: req.user, huntId: uid(), isLive: false, startedAt: null, archivedAt: null, tenantId: req.tenant.id,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType: 'community', bonuses: [], equity: [], calls: [], invitedEditors: [], callLimit: 10, currency: 'USD', publicCalls: false, publicCallsPin: null
    };
    const { bonuses, equity, calls, huntType, callLimit, huntMode, roundRobin, lockTop4, currency, publicCalls, publicCallsPin, currentSlot, manualOrder } = req.body;
    if (bonuses    !== undefined) hunts[req.user.id].bonuses    = bonuses;
    if (equity     !== undefined) hunts[req.user.id].equity     = equity;
    if (calls      !== undefined) hunts[req.user.id].calls      = calls;
    if (huntType   !== undefined) {
      if (huntType === 'vip' && !reqIsMod(req))
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
    if (manualOrder !== undefined) hunts[req.user.id].manualOrder = manualOrder;
    touch(req.user.id);
    persistHunts();
    io.to(`hunt:${req.user.id}`).emit('hunt:update', publicHuntView(hunts[req.user.id]));
    emitHubUpdate(req.tenant.id);
    res.json({ok:true});
  });

  // ── Invite editor ──────────────────────────────────────────────────
  router.post('/api/my-hunt/invite', requireAuth, (req, res) => {
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

  router.delete('/api/my-hunt/invite', requireAuth, (req, res) => {
    const { username } = req.body;
    if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
    hunts[req.user.id].invitedEditors = (hunts[req.user.id].invitedEditors||[])
      .filter(u => u !== username.toLowerCase().trim());
    persistHunts();
    io.to(`hunt:${req.user.id}`).emit('hunt:reinvite', { huntUserId: req.user.id });
    res.json({ok:true, invitedEditors: hunts[req.user.id].invitedEditors});
  });

  return router;
};
