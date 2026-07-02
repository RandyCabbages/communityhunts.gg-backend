// OverDrop — remote stream overlay control. Mods/admins push images, text, sounds and
// video clips onto the community's stream; the streamer's OBS loads the (public, read-only)
// source page which listens on the `overdrop:<slug>` socket room.
//
// SECURITY MODEL: the socket layer is unauthenticated (see sockets/index.js), so sockets are
// READ-ONLY here — clients only ever `watch:overdrop` to receive state. Every mutation goes
// through routes/overdrop.routes.js behind requireMod. Never add a socket-driven mutation.
//
// State is per-tenant and in-memory only (deliberately: this is transient on-stream content;
// a deploy clearing it is fine). initOverdrop(io) must be called once before any mutation —
// same DI pattern as lib/persistence.js.

let io = null;

const MAX_ITEMS = 50;
const states = new Map();    // slug -> { items: [], audio: null }
const ttlTimers = new Map(); // `${slug}:${itemId}` -> timeout handle

function initOverdrop(ioServer) { io = ioServer; }

function room(slug) { return `overdrop:${slug}`; }

function getState(slug) {
  if (!states.has(slug)) states.set(slug, { items: [], audio: null });
  return states.get(slug);
}

function num(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Only allow real web URLs as media sources — never javascript:/data:/etc.
function safeUrl(v) {
  const s = String(v || '').slice(0, 2000).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function newId() { return Math.random().toString(36).slice(2, 12); }

// Geometry is PERCENTAGES of the stage (x/y = item center, w = width, text `size` =
// font-size as % of stage width) so the mod's preview and any OBS resolution match 1:1.
function sanitizeItem(raw) {
  const type = ['image', 'text', 'video'].includes(raw.type) ? raw.type : 'image';
  const item = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 24) : newId(),
    type,
    x: num(raw.x, 50, -20, 120),
    y: num(raw.y, 50, -20, 120),
    w: num(raw.w, 25, 1, 200),
    rot: num(raw.rot, 0, -180, 180),
    z: num(raw.z, 1, 0, 999),
    ttl: num(raw.ttl, 0, 0, 3600), // seconds; 0 = stays until removed
  };
  if (type === 'text') {
    item.text = String(raw.text || '').slice(0, 300);
    item.font = String(raw.font || 'Bangers').slice(0, 60);
    item.size = num(raw.size, 6, 0.5, 40);
    item.color = String(raw.color || '#ffffff').slice(0, 30);
  } else {
    item.src = safeUrl(raw.src);
    if (type === 'video') {
      item.loop = !!raw.loop;
      item.muted = !!raw.muted;
    }
  }
  return item;
}

function clearTtl(slug, id) {
  const key = `${slug}:${id}`;
  const t = ttlTimers.get(key);
  if (t) { clearTimeout(t); ttlTimers.delete(key); }
}

function scheduleRemove(slug, id, ttlSeconds) {
  ttlTimers.set(`${slug}:${id}`, setTimeout(() => removeItem(slug, id), ttlSeconds * 1000));
}

// ── Mutations (routes-only; each broadcasts to the tenant's room) ──

function addItem(slug, raw) {
  const st = getState(slug);
  if (st.items.length >= MAX_ITEMS) return null;
  const item = sanitizeItem(raw || {});
  if (item.type !== 'text' && !item.src) return null; // URL rejected by safeUrl
  st.items.push(item);
  io.to(room(slug)).emit('overdrop:item:add', item);
  if (item.ttl > 0) scheduleRemove(slug, item.id, item.ttl);
  return item;
}

function updateItem(slug, id, raw) {
  const st = getState(slug);
  const i = st.items.findIndex(it => it.id === id);
  if (i === -1) return null;
  // Merge partial update; id and type can never change.
  const merged = sanitizeItem({ ...st.items[i], ...raw, id: st.items[i].id, type: st.items[i].type });
  st.items[i] = merged;
  io.to(room(slug)).emit('overdrop:item:update', merged);
  return merged;
}

function removeItem(slug, id) {
  const st = getState(slug);
  const before = st.items.length;
  st.items = st.items.filter(it => it.id !== id);
  clearTtl(slug, id);
  if (st.items.length === before) return false;
  io.to(room(slug)).emit('overdrop:item:remove', id);
  return true;
}

function clearAll(slug) {
  const st = getState(slug);
  for (const it of st.items) clearTtl(slug, it.id);
  st.items = [];
  st.audio = null;
  io.to(room(slug)).emit('overdrop:clear');
}

function playAudio(slug, raw) {
  const src = safeUrl(raw?.src);
  if (!src) return null;
  const st = getState(slug);
  st.audio = {
    src,
    volume: num(raw?.volume, 0.8, 0, 1),
    loop: !!raw?.loop,
    title: String(raw?.title || '').slice(0, 100),
    startedAt: Date.now(), // source page keys its <audio> on this so replays restart
  };
  io.to(room(slug)).emit('overdrop:audio:play', st.audio);
  return st.audio;
}

function updateAudio(slug, raw) {
  const st = getState(slug);
  if (!st.audio) return null;
  if (raw && raw.volume !== undefined) st.audio.volume = num(raw.volume, st.audio.volume, 0, 1);
  if (raw && raw.loop !== undefined) st.audio.loop = !!raw.loop;
  io.to(room(slug)).emit('overdrop:audio:update', { volume: st.audio.volume, loop: st.audio.loop });
  return st.audio;
}

function stopAudio(slug) {
  getState(slug).audio = null;
  io.to(room(slug)).emit('overdrop:audio:stop');
}

module.exports = {
  initOverdrop, getState,
  addItem, updateItem, removeItem, clearAll,
  playAudio, updateAudio, stopAudio,
};
