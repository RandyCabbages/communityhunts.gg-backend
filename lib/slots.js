// Slot autocomplete + image proxy. Self-contained: no hunts/archive/io/auth coupling.
// Loads the pre-scraped Rainbet slot list + softswiss thumb hits from JSON at the
// backend root, caches an in-memory mapped list, and serves a CORS-safe image proxy.
// Extracted from server.js (de-slop refactor, 2026-06-20). Behavior unchanged.

const fs = require('fs');
const path = require('path');

// JSON data files live at the backend root (one level up from lib/).
const ROOT = path.join(__dirname, '..');

// ── Slot Autocomplete ─────────────────────────────────────────────
let slotCache = { games: [], thumbMap: {}, fetchedAt: 0 };

// Provider prefixes used in Rainbet slugs (sorted by length desc to match longest first)
const RAINBET_PROVIDERS = [
  'big-time-gaming','massive-studios','backseat-gaming','bullshark-games',
  'foxhound-games','kitsune-studios','pineapple-play','print-studios',
  'pragmatic-play','nownow-gaming','clutch-gaming','jinx-gaming',
  'relax-gaming','red-tiger','playn-go','play-n-go','peter-sons',
  'shady-lady','trusty-gaming','elk-studios','iron-dog','push-gaming',
  'blueprint','spinomenal','thunderkick','yggdrasil','quickspin',
  'wazdan','hacksaw','nolimit','playngo','bgaming','popiplay',
  'voltent','habanero','endorphina','betsoft','1spin4win','pgsoft',
  'mascot','penguin','amigo','3-oaks','belatra','retro','platipus',
  'avatarux','zillion','clawbuster','truelab','slotmill','fantasma',
  'isoftbet','netent','ace-roll','onetouch','gameart','gamomat',
].sort((a, b) => b.length - a.length);

// Maps internal provider IDs to Rainbet's URL prefix format
const PROVIDER_URL_MAP = {
  'pragmatic-play':'pragmatic-play','playngo':'play-n-go','play-n-go':'play-n-go',
  'hacksaw':'hacksaw','hacksaw-gaming':'hacksaw',
  'nolimit':'nolimit','nolimit-city':'nolimit',
  'blueprint':'blueprint','blueprint-gaming':'blueprint',
  'relax':'relax','relax-gaming':'relax',
};

function rainbetExtractProvider(rainbetSlug) {
  for (const p of RAINBET_PROVIDERS) {
    if (rainbetSlug.startsWith(p + '-')) {
      return { provider: p, slug: rainbetSlug.slice(p.length + 1) };
    }
  }
  // Couldn't parse — use first segment as provider
  const idx = rainbetSlug.indexOf('-');
  if (idx > 0) return { provider: rainbetSlug.slice(0, idx), slug: rainbetSlug.slice(idx + 1) };
  return { provider: '', slug: rainbetSlug };
}

// Load pre-scraped Rainbet slot list (authoritative source, ~6700 slots)
let RAINBET_SLOTS = [];
const RAINBET_SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');
try {
  if (fs.existsSync(RAINBET_SLOTS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(RAINBET_SLOTS_FILE, 'utf8'));
    // Expected format: array of {name, rainbetSlug, thumb}
    // Normalize and URL-encode the path portion of thumb (filenames have spaces)
    RAINBET_SLOTS = raw.map(s => {
      const { provider, slug } = rainbetExtractProvider(s.rainbetSlug || '');
      let thumb = s.thumb || null;
      if (thumb) {
        // Re-encode any unsafe characters in the path
        const match = thumb.match(/^(https?:\/\/[^/]+)(\/.*)$/);
        if (match) {
          const [, origin, path] = match;
          thumb = origin + path.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
        }
      }
      return { name: s.name, slug, provider, rainbetSlug: s.rainbetSlug, thumb };
    }).filter(s => s.name && s.thumb);
    console.log(`[slots] Loaded ${RAINBET_SLOTS.length} slots from rainbet_slots.json`);
  } else {
    console.log('[slots] rainbet_slots.json not found, using slot.report only');
  }
} catch(e) { console.error('[slots] Failed to load rainbet_slots.json:', e.message); }

// Hardcoded thumbnail overrides for slots with non-standard naming
const EXTRA_THUMBS = {
  'fire-in-the-hole-xbomb': 'https://cdn.softswiss.net/i/s4/nolimit/FireInTheHolexBomb.webp',
  'dog-house-megaways':      'https://cdn.softswiss.net/i/s4/pragmatic/TheDogHouseMegaways.webp',
  'book-of-dead':            'https://cdn.softswiss.net/i/s4/playngo/BookofDead.webp',
  'the-jack-rose':           'https://cdn.softswiss.net/i/s4/hacksaw/TheJackandRose.webp',
  'junkyard-kings-2':        'https://cdn.softswiss.net/i/s4/hacksaw/JunkyardKings2.webp',
  'rusty-and-curly':         'https://cdn.softswiss.net/i/s4/hacksaw/RustyAndCurly.webp',
  'hop-n-pop':               'https://cdn.softswiss.net/i/s4/hacksaw/HopnPop.webp',
  'san-quentin-xways':       'https://cdn.softswiss.net/i/s4/nolimit/SanQuentinXWays.webp',
};

// Load pre-verified softswiss CDN hits (tested at build time, ~1900 slots)
let SOFTSWISS_HITS = {};
const SOFTSWISS_HITS_FILE = path.join(ROOT, 'softswiss_hits.json');
try {
  if (fs.existsSync(SOFTSWISS_HITS_FILE)) {
    SOFTSWISS_HITS = JSON.parse(fs.readFileSync(SOFTSWISS_HITS_FILE, 'utf8'));
    console.log(`[slots] Loaded ${Object.keys(SOFTSWISS_HITS).length} pre-verified softswiss thumbs`);
  }
} catch(e) { console.error('[slots] Failed to load softswiss hits:', e.message); }

function toPascal(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// Only show slots from providers available on Rainbet/crypto casinos
const RELEVANT_PROVIDERS = new Set([
  'pragmatic-play', 'playngo', 'hacksaw-gaming', 'elk-studios',
  'red-tiger', 'relax-gaming', 'quickspin', 'blueprint-gaming',
  'nolimit-city', 'bgaming', 'thunderkick', 'yggdrasil',
  'push-gaming', 'netent', 'isoftbet', 'gameart', 'wazdan',
  'big-time-gaming', 'iron-dog-studio', 'spinomenal',
  // slot.report reviewed providers (hacksaw sub-labels etc.)
  'bullshark-games', 'backseat-gaming', 'print-studios',
  'nownow-gaming', 'trusty-gaming', 'kitsune-studios',
  'ace-roll', 'foxhound-games', 'jinx-gaming', 'pineapple-play',
]);

async function getSlotGames() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (slotCache.games.length && Date.now() - slotCache.fetchedAt < ONE_HOUR) {
    return slotCache;
  }
  try {
    const [gamesRes, thumbRes] = await Promise.all([
      fetch('https://slot.report/api/v1/slots.json'),
      fetch('https://slot.report/data/slots-cards.js')
    ]);
    const gamesData = await gamesRes.json();
    const thumbText = await thumbRes.text();

    // Build verified thumb map AND reviewed slug set (these are the popular slots)
    const thumbMap = {};
    const reviewedSlugs = new Set();
    const thumbMatch = thumbText.match(/var SLOT_DATA=([\s\S]*?]);/);
    if (thumbMatch) {
      try {
        const reviewed = JSON.parse(thumbMatch[1]);
        reviewed.forEach(s => {
          if (s.slug && s.thumbnail) {
            thumbMap[s.slug] = `https://slot.report${s.thumbnail.split('?')[0]}`;
            reviewedSlugs.add(s.slug);
          }
        });
        console.log(`[slots] Loaded ${reviewedSlugs.size} reviewed thumbnails`);
      } catch(e) { console.error('[slots] Failed to parse slots-cards.js:', e.message); }
    }

    // Hardcoded extra thumbs for naming exceptions
    const EXTRA_THUMBS_LOCAL = {
      'fire-in-the-hole-xbomb': 'https://cdn.softswiss.net/i/s4/nolimit/FireInTheHolexBomb.webp',
      'dog-house-megaways':      'https://cdn.softswiss.net/i/s4/pragmatic/TheDogHouseMegaways.webp',
      'book-of-dead':            'https://cdn.softswiss.net/i/s4/playngo/BookofDead.webp',
      'the-jack-rose':           'https://cdn.softswiss.net/i/s4/hacksaw/TheJackandRose.webp',
      'junkyard-kings-2':        'https://cdn.softswiss.net/i/s4/hacksaw/JunkyardKings2.webp',
      'rusty-and-curly':         'https://cdn.softswiss.net/i/s4/hacksaw/RustyAndCurly.webp',
      'hop-n-pop':               'https://cdn.softswiss.net/i/s4/hacksaw/HopnPop.webp',
      'san-quentin-xways':       'https://cdn.softswiss.net/i/s4/nolimit/SanQuentinXWays.webp',
    };
    Object.entries(EXTRA_THUMBS_LOCAL).forEach(([slug, url]) => {
      if (!thumbMap[slug]) thumbMap[slug] = url;
    });

    // Filter to relevant providers only, sort reviewed slots first
    const allGames = (gamesData.results || []).filter(s => s.name);

    // Only include slots that are confirmed on Rainbet:
    // - Have a confirmed thumbnail (Rainbet CDN, Softswiss CDN, or scraped from provider sites)
    // - This filters ~2600 confirmed Rainbet slots from the full ~6000 slot list
    const relevant = allGames.filter(g =>
      thumbMap[g.slug] || SOFTSWISS_HITS[g.slug] || reviewedSlugs.has(g.slug)
    );

    // Deduplicate by slug (keep first occurrence)
    const seenSlugs = new Set();
    const deduped = relevant.filter(g => {
      if (seenSlugs.has(g.slug)) return false;
      seenSlugs.add(g.slug);
      return true;
    });

    deduped.sort((a, b) => {
      const aR = reviewedSlugs.has(a.slug), bR = reviewedSlugs.has(b.slug);
      if (aR && !bR) return -1;
      if (!aR && bR) return 1;
      return a.name.localeCompare(b.name);
    });

    slotCache.games     = deduped;
    slotCache.thumbMap  = thumbMap;
    slotCache.fetchedAt = Date.now();
    console.log(`[slots] Cached ${relevant.length} relevant slots (from ${allGames.length} total)`);
  } catch(e) {
    console.error('[slots] Failed to fetch slot list:', e.message);
  }
  return slotCache;
}

// Pre-fetch on startup (called from server.js composition root)
function prefetchSlots() {
  getSlotGames().catch(() => {});
}

// ── Image proxy — serves CORS-blocked thumbnails (e.g. pragmaticplay.com) through our backend
const imgProxyCache = new Map(); // url -> {buf, ct, at}
const IMG_PROXY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const ALLOWED_IMG_HOSTS = ['www.pragmaticplay.com', 'pragmaticplay.com', 'cdn.softswiss.net', 'cdn.rainbet.com', 'slot.report', 'www.thunderkick.com', 'static.wixstatic.com'];

async function imgProxyHandler(req, res) {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });
  try {
    const parsed = new URL(url);
    if (!ALLOWED_IMG_HOSTS.includes(parsed.hostname)) {
      return res.status(403).json({ error: 'Host not allowed' });
    }
    // Check cache
    const cached = imgProxyCache.get(url);
    if (cached && Date.now() - cached.at < IMG_PROXY_TTL) {
      res.set('Content-Type', cached.ct);
      res.set('Cache-Control', 'public, max-age=86400');
      res.set('Access-Control-Allow-Origin', '*');
      return res.send(cached.buf);
    }
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' } });
    if (!resp.ok) return res.status(resp.status).end();
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
    const buf = Buffer.from(await resp.arrayBuffer());
    imgProxyCache.set(url, { buf, ct, at: Date.now() });
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

async function slotsSearchHandler(req, res) {
  const q     = (req.query.q || '').toLowerCase().trim();
  const limit = parseInt(req.query.limit) || 20;

  // Build full mapped list once and cache it
  if (!getSlotGames._mappedCache) {
    // Rainbet scraped slots only (authoritative; ~6700 with thumbnails)
    getSlotGames._mappedCache = RAINBET_SLOTS.map(s => ({
      name: s.name,
      slug: s.slug,
      provider: s.provider,
      rainbetSlug: s.rainbetSlug,
      thumb: s.thumb,
    }));
    console.log(`[slots] Built mapped cache: ${getSlotGames._mappedCache.length} Rainbet slots`);
  }

  const pool = getSlotGames._mappedCache;
  const filtered = q.length >= 2
    ? pool.filter(g => g.name.toLowerCase().includes(q))
    : pool;

  const results = filtered
    .slice()
    .sort((a, b) => {
      if (q.length >= 2) {
        const aStarts = a.name.toLowerCase().startsWith(q);
        const bStarts = b.name.toLowerCase().startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
      }
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);

  res.json(results);
}

module.exports = {
  getSlotGames,
  prefetchSlots,
  imgProxyHandler,
  slotsSearchHandler,
};
