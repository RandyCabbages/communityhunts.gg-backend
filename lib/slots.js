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
  'amigo-gaming','mascot-gaming','penguin-king','playnetic','aceroll',
].sort((a, b) => b.length - a.length);

// Maps internal provider IDs to Rainbet's URL prefix format
const PROVIDER_URL_MAP = {
  'pragmatic-play':'pragmatic-play','playngo':'play-n-go','play-n-go':'play-n-go',
  'hacksaw':'hacksaw','hacksaw-gaming':'hacksaw',
  'nolimit':'nolimit','nolimit-city':'nolimit',
  'blueprint':'blueprint','blueprint-gaming':'blueprint',
  'relax':'relax','relax-gaming':'relax',
};

// slot.report provider_slug → Rainbet URL prefix (for constructing slugs of new releases)
const SLOT_REPORT_TO_RAINBET = {
  'playngo':'play-n-go','hacksaw-gaming':'hacksaw','nolimit-city':'nolimit',
  'blueprint-gaming':'blueprint','relax-gaming':'relax','iron-dog-studio':'iron-dog',
  'backseat-gaming':'backseat-gaming','bullshark-games':'bullshark-games',
  'print-studios':'print-studios','nownow-gaming':'nownow-gaming',
  'trusty-gaming':'trusty-gaming','kitsune-studios':'kitsune-studios',
  'foxhound-games':'foxhound-games','jinx-gaming':'jinx-gaming',
  'pineapple-play':'pineapple-play',
};

// slot.report's nginx now 403s requests without a same-origin Referer. Send
// browser-like headers on every slot.report fetch so the API responds.
const SLOT_REPORT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/137.0.6934.79 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://slot.report/',
};

// slot.report provider_slug → SoftSwiss CDN provider segment, for guessing a real
// thumbnail for slots slot.report hasn't reviewed (mirrors frontend slotThumb.js).
const SOFTSWISS_PROVIDER = {
  'pragmatic-play':'pragmatic','playngo':'playngo','hacksaw-gaming':'hacksaw',
  'nolimit-city':'nolimitcity','elk-studios':'elk','red-tiger':'redtiger',
  'relax-gaming':'relax','bgaming':'bgaming','thunderkick':'thunderkick',
  'yggdrasil':'yggdrasil','push-gaming':'pushgaming','netent':'netent',
  'quickspin':'quickspin','blueprint-gaming':'blueprint','big-time-gaming':'bigtimegaming',
  'spinomenal':'spinomenal','isoftbet':'isoftbet','wazdan':'wazdan',
  'iron-dog-studio':'irondog','gameart':'gameart',
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
const RAINBET_SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');

function loadRainbetSlots() {
  try {
    if (!fs.existsSync(RAINBET_SLOTS_FILE)) {
      console.log('[slots] rainbet_slots.json not found, using slot.report only');
      return [];
    }
    const raw = JSON.parse(fs.readFileSync(RAINBET_SLOTS_FILE, 'utf8'));
    // Expected format: array of {name, rainbetSlug, thumb}
    // Normalize and URL-encode the path portion of thumb (filenames have spaces)
    const mapped = raw.map(s => {
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
    }).filter(s => s.name); // thumb may be null — frontend's SlotThumb renders a fallback tile
    console.log(`[slots] Loaded ${mapped.length} slots from rainbet_slots.json`);
    return mapped;
  } catch(e) {
    console.error('[slots] Failed to load rainbet_slots.json:', e.message);
    return [];
  }
}

let RAINBET_SLOTS = loadRainbetSlots();

// Re-reads rainbet_slots.json from disk and refreshes the in-memory search pool.
// Called after the live scrape check (lib/rainbetSlotSync.js) writes new slots,
// so they're searchable immediately without waiting for a redeploy.
function reloadRainbetSlots() {
  RAINBET_SLOTS = loadRainbetSlots();
  rebuildSearchPool();
}

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
  // additional Rainbet providers
  'habanero', 'endorphina', 'betsoft', '1spin4win', 'pgsoft', 'mascot',
  'peter-and-sons', '3-oaks', 'belatra', 'platipus', 'avatarux',
  'truelab', 'slotmill', 'fantasma', 'popiplay', 'gamomat', 'onetouch',
  'massive-studios', 'clutch-gaming', 'shady-lady',
  'playnetic', 'amigo-gaming', 'penguin-king', 'mascot-gaming', 'aceroll',
]);

async function getSlotGames() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (slotCache.games.length && Date.now() - slotCache.fetchedAt < ONE_HOUR) {
    return slotCache;
  }
  try {
    const [gamesRes, thumbRes] = await Promise.all([
      fetch('https://slot.report/api/v1/slots.json', { headers: SLOT_REPORT_HEADERS }),
      fetch('https://slot.report/data/slots-cards.js', { headers: SLOT_REPORT_HEADERS })
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

    // Filter to relevant providers (available on Rainbet)
    const allGames = (gamesData.results || []).filter(s => s.name);
    const relevant = allGames.filter(g => RELEVANT_PROVIDERS.has(g.provider_slug));

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

let _searchPool = null;
let _searchPoolVersion = 0;

function rebuildSearchPool() {
  const seenSlugs = new Set();
  const seenNames = new Set();
  const pool = [];

  // 1. Rainbet scraped data — authoritative (exact slugs + CDN thumbs)
  for (const s of RAINBET_SLOTS) {
    const key = (s.rainbetSlug || '').toLowerCase();
    if (key) seenSlugs.add(key);
    seenNames.add(s.name.toLowerCase());
    pool.push({
      name: s.name, slug: s.slug, provider: s.provider,
      rainbetSlug: s.rainbetSlug, thumb: s.thumb,
    });
  }

  // 2. slot.report data — fills gaps with new releases not yet in the scraped file
  if (slotCache.games.length > 0) {
    let added = 0;
    for (const g of slotCache.games) {
      if (seenNames.has(g.name.toLowerCase())) continue;
      const rbProvider = SLOT_REPORT_TO_RAINBET[g.provider_slug]
        || PROVIDER_URL_MAP[g.provider_slug] || g.provider_slug;
      const constructed = `${rbProvider}-${g.slug}`;
      if (seenSlugs.has(constructed.toLowerCase())) continue;
      seenSlugs.add(constructed.toLowerCase());
      seenNames.add(g.name.toLowerCase());

      let thumb = slotCache.thumbMap[g.slug] || SOFTSWISS_HITS[g.slug]
        || EXTRA_THUMBS[g.slug] || null;
      if (thumb && thumb.startsWith('/')) thumb = `https://slot.report${thumb}`;
      // Last resort: guess a SoftSwiss CDN URL. The old cdn.rainbet.com/{name}.png
      // pattern 404'd for every slot (Rainbet appends opaque filename suffixes), so it
      // only ever produced dead links. The frontend's <img> fallback chain handles a
      // SoftSwiss miss gracefully (slot.report webp → SVG tile).
      if (!thumb) {
        const ss = SOFTSWISS_PROVIDER[g.provider_slug];
        thumb = ss ? `https://cdn.softswiss.net/i/s4/${ss}/${toPascal(g.slug)}.webp` : null;
      }

      pool.push({
        name: g.name, slug: g.slug, provider: g.provider_slug,
        rainbetSlug: constructed, thumb,
      });
      added++;
    }
    if (added > 0) console.log(`[slots] merged ${added} slot.report slots into search pool (total: ${pool.length})`);
  }

  _searchPool = pool;
  _searchPoolVersion = slotCache.fetchedAt;
  return pool;
}

// Ensure the search pool exists (rebuilds when slot.report data refreshes) and return it.
function getSearchPool() {
  if (!_searchPool || _searchPoolVersion !== slotCache.fetchedAt) rebuildSearchPool();
  return _searchPool || [];
}

// Human-readable provider names for the random-slots provider filter. Falls back to
// title-casing the slug for anything not listed here.
const PROVIDER_DISPLAY = {
  'pragmatic-play':'Pragmatic Play', 'hacksaw':'Hacksaw Gaming', 'hacksaw-gaming':'Hacksaw Gaming',
  'nolimit':'Nolimit City', 'nolimit-city':'Nolimit City', 'play-n-go':"Play'n GO", 'playngo':"Play'n GO",
  'push-gaming':'Push Gaming', 'big-time-gaming':'Big Time Gaming', 'relax':'Relax Gaming',
  'red-tiger':'Red Tiger', 'elk-studios':'ELK Studios', 'blueprint':'Blueprint Gaming',
  'thunderkick':'Thunderkick', 'yggdrasil':'Yggdrasil', 'quickspin':'Quickspin', 'netent':'NetEnt',
  'bgaming':'BGaming', 'pgsoft':'PG Soft', 'wazdan':'Wazdan', 'gameart':'GameArt',
  'clutch-gaming':'Clutch Gaming',
};
function prettyProvider(slug) {
  if (!slug) return 'Unknown';
  return PROVIDER_DISPLAY[slug] || slug.split('-').map(w => w ? w[0].toUpperCase()+w.slice(1) : w).join(' ');
}

const POPULAR_NORM = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

// GET /api/slots/popular — slot popularity for "Add Random Slots", enriched with provider.
// getSlotCallCounts(tenantId) is injected (lives in hunts-core, owns hunts/archive). We attach
// the provider from our search pool by normalized name, then rank the top 5 providers.
function makePopularHandler(getSlotCallCounts) {
  return function popularHandler(req, res) {
    const tenantId = req.tenant?.slug || 'bean';
    const { calls, bonuses } = getSlotCallCounts(tenantId);
    const pool = getSearchPool();
    const byName = new Map();
    for (const s of pool) { const k = POPULAR_NORM(s.name); if (k && !byName.has(k)) byName.set(k, s); }
    const enrich = list => list.map(it => {
      const m = byName.get(POPULAR_NORM(it.name));
      return { name: it.name, count: it.count, provider: m?.provider || null };
    });
    const topCalls = enrich(calls), topGotIn = enrich(bonuses);
    // Rank providers by got-in popularity (fall back to calls), then pad to 5 with defaults.
    const provCount = new Map();
    for (const it of (topGotIn.length ? topGotIn : topCalls)) {
      if (!it.provider) continue;
      provCount.set(it.provider, (provCount.get(it.provider)||0) + it.count);
    }
    let providers = [...provCount.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([slug,count]) => ({ slug, name: prettyProvider(slug), count }));
    if (providers.length < 5) {
      const have = new Set(providers.map(p=>p.slug));
      for (const slug of ['pragmatic-play','hacksaw','nolimit','play-n-go','push-gaming']) {
        if (providers.length >= 5) break;
        if (!have.has(slug)) { providers.push({ slug, name: prettyProvider(slug), count: 0 }); have.add(slug); }
      }
    }
    // Always offer Clutch Gaming as a filter option, even if it didn't rank into the top 5.
    if (!providers.some(p => p.slug === 'clutch-gaming')) {
      providers.push({ slug: 'clutch-gaming', name: prettyProvider('clutch-gaming'), count: provCount.get('clutch-gaming') || 0 });
    }
    res.json({ providers, topCalls, topGotIn });
  };
}

async function slotsSearchHandler(req, res) {
  const q     = (req.query.q || '').toLowerCase().trim();
  const limit = parseInt(req.query.limit) || 20;

  // Rebuild when slot.report data refreshes (hourly) or on first call
  if (!_searchPool || _searchPoolVersion !== slotCache.fetchedAt) {
    rebuildSearchPool();
  }

  const pool = _searchPool;
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
  makePopularHandler,
  reloadRainbetSlots,
};
