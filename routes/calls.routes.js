// Slot-call + call-permission routes:
//   POST /api/hunts/:userId/calls                      — equity member adds a call
//   POST /api/hunts/:userId/public-calls               — public link adds a call (optional PIN)
//   PUT  /api/hunts/:userId                            — edit any hunt (admin/editor)
//   POST /api/hunts/:userId/request-calls              — request call permission
//   GET  /api/hunts/:userId/call-requests              — pending requests (owner/admin)
//   POST /api/hunts/:userId/call-requests/:requestId   — grant/deny a request
// Thin router; mounted from the server.js composition root. hunts is the persistence-owned
// singleton (by reference). Every hunt:update broadcast goes through publicHuntView.
// huntCallRequests is process-local pending-request state, owned here.

const express = require('express');

module.exports = function callsRoutes(deps) {
  const {
    hunts, io, persistHunts,
    requireAuth, canEditHunt, isEquityMember, reqIsAdmin,
    normalizeSlot, nameOf, publicHuntView, emitHubUpdate, uid, rejectBadHuntInput,
  } = deps;
  const router = express.Router();

  // huntCallRequests[huntOwnerId] = [{id, userId, displayName, avatar, requestedAt}]
  const huntCallRequests = {};

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
  router.post('/api/hunts/:userId/calls', requireAuth, (req, res) => {
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
  router.post('/api/hunts/:userId/public-calls', requireAuth, (req, res) => {
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
  router.put('/api/hunts/:userId', requireAuth, (req, res) => {
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

  // ── Call Permission Requests ─────────────────────────────────────
  // Request permission to add calls
  router.post('/api/hunts/:userId/request-calls', requireAuth, (req, res) => {
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
  router.get('/api/hunts/:userId/call-requests', requireAuth, (req, res) => {
    if (req.user.id !== req.params.userId && !reqIsAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
    res.json(huntCallRequests[req.params.userId] || []);
  });

  // Grant or deny a request
  router.post('/api/hunts/:userId/call-requests/:requestId', requireAuth, (req, res) => {
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

  return router;
};
