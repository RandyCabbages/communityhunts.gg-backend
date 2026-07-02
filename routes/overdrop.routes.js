// OverDrop routes — mod/admin remote control of the community's stream overlay.
// All mutations are requireMod-gated (per-tenant, resolves via req.tenant — see lib/auth.js);
// state + broadcasts live in lib/overdrop.js. The OBS source page consumes state read-only
// over the `overdrop:<slug>` socket room (joined via watch:overdrop in sockets/index.js).
//
//   GET    /api/overdrop            — current state (control panel initial load)
//   POST   /api/overdrop/items      — add an item (image/text/video)
//   PUT    /api/overdrop/items/:id  — partial update (drag/resize/rotate/edit)
//   DELETE /api/overdrop/items/:id  — remove one item
//   POST   /api/overdrop/clear      — panic: clear all items + audio
//   POST   /api/overdrop/audio      — play a sound/music URL
//   PUT    /api/overdrop/audio      — live-update volume/loop
//   DELETE /api/overdrop/audio      — stop audio

const express = require('express');

module.exports = function overdropRoutes(deps) {
  const { requireMod, overdrop } = deps;
  const router = express.Router();
  const slugOf = (req) => req.tenant.slug;

  router.get('/api/overdrop', requireMod, (req, res) => {
    res.json(overdrop.getState(slugOf(req)));
  });

  router.post('/api/overdrop/items', requireMod, (req, res) => {
    const item = overdrop.addItem(slugOf(req), req.body || {});
    if (!item) return res.status(400).json({ error: 'Invalid URL or item limit reached' });
    res.json(item);
  });

  router.put('/api/overdrop/items/:id', requireMod, (req, res) => {
    const item = overdrop.updateItem(slugOf(req), String(req.params.id), req.body || {});
    if (!item) return res.status(404).json({ error: 'No such item' });
    res.json(item);
  });

  router.delete('/api/overdrop/items/:id', requireMod, (req, res) => {
    overdrop.removeItem(slugOf(req), String(req.params.id));
    res.json({ ok: true });
  });

  router.post('/api/overdrop/clear', requireMod, (req, res) => {
    overdrop.clearAll(slugOf(req));
    res.json({ ok: true });
  });

  router.post('/api/overdrop/audio', requireMod, (req, res) => {
    const audio = overdrop.playAudio(slugOf(req), req.body || {});
    if (!audio) return res.status(400).json({ error: 'Valid http(s) audio URL required' });
    res.json(audio);
  });

  router.put('/api/overdrop/audio', requireMod, (req, res) => {
    const audio = overdrop.updateAudio(slugOf(req), req.body || {});
    if (!audio) return res.status(404).json({ error: 'Nothing playing' });
    res.json(audio);
  });

  router.delete('/api/overdrop/audio', requireMod, (req, res) => {
    overdrop.stopAudio(slugOf(req));
    res.json({ ok: true });
  });

  return router;
};
