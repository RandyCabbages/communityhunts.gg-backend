// Slot autocomplete + image proxy routes. Thin router over lib/slots.js.
// Mounted from the server.js composition root.
//   GET /api/img-proxy      → CORS-safe image proxy (allowlisted hosts, 24h cache)
//   GET /api/slots/search   → slot autocomplete from the Rainbet list

const express = require('express');

module.exports = function slotsRoutes(deps) {
  const { slots } = deps;
  const router = express.Router();

  router.get('/api/img-proxy', slots.imgProxyHandler);
  router.get('/api/slots/search', slots.slotsSearchHandler);

  return router;
};
