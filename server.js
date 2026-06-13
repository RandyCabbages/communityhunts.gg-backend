const express         = require('express');
const session         = require('express-session');
const passport        = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors            = require('cors');
const http            = require('http');
const { Server }      = require('socket.io');
const fs              = require('fs');
const path            = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }
});

const PORT           = process.env.PORT || 3001;
const FRONTEND_URL   = process.env.FRONTEND_URL || 'http://localhost:3000';
const SESSION_SECRET = process.env.SESSION_SECRET || 'beanhunt-secret';
const ADMINS         = (process.env.ADMINS || 'bean,randycabbage,randy cabbage,mcflurry,mihallimou,missingiscool,cuda,cabbage').toLowerCase().split(',').map(s=>s.trim());
const ADMIN_IDS      = (process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const VIP_HOSTS      = (process.env.VIP_HOSTS || 'bean,mcflurry,mihallimou,missingiscool,cuda,randycabbage,cabbage').toLowerCase().split(',').map(s=>s.trim());
const VIP_IDS        = (process.env.VIP_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);

function nameOf(user) { return (user?.displayName || user?.username || '').toLowerCase().trim(); }
function isAdmin(user) {
  if (!user) return false;
  if (user.id && ADMIN_IDS.length && ADMIN_IDS.includes(user.id)) return true;
  return ADMINS.includes(nameOf(user));
}
function isVipHost(user) {
  if (!user) return false;
  if (user.id && VIP_IDS.length && VIP_IDS.includes(user.id)) return true;
  return VIP_HOSTS.includes(nameOf(user));
}
function canEditHunt(user, huntOwnerId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.id === huntOwnerId) return true;
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  const name = nameOf(user);
  const nameNoSp = name.replace(/\s+/g,'');
  const invites = hunt.invitedEditors || [];
  return invites.some(inv => {
    const invLow = inv.toLowerCase().trim();
    return invLow === name || invLow === nameNoSp || 
           invLow.replace(/\s+/g,'') === name || invLow.replace(/\s+/g,'') === nameNoSp ||
           inv === user.id;
  });
}
function isEquityMember(user, huntOwnerId) {
  if (!user) return false;
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  const name = nameOf(user);
  // Also check callsPermissions (granted via request)
  if (user?.id && hunt.callsPermissions && hunt.callsPermissions.includes(user.id)) return true;
  // Match on Discord ID first (most reliable), then name fuzzy match
  const userId = user?.id;
  const nameNoSpaces = name.replace(/\s+/g,'');
  return hunt.equity.some(e => {
    if (!e.name && !e.discordId) return false;
    if (userId && e.discordId && e.discordId === userId) return true;
    const en = (e.name||'').toLowerCase().trim();
    const enNoSpaces = en.replace(/\s+/g,'');
    return en === name || enNoSpaces === nameNoSpaces || en === nameNoSpaces || enNoSpaces === name;
  });
}

// ── Middleware ─────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── Passport ───────────────────────────────────────────────────────
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || `http://localhost:${PORT}/auth/discord/callback`,
  scope: ['identify']
}, (access, refresh, profile, done) => done(null, {
  id: profile.id,
  username: profile.username,
  displayName: profile.global_name || profile.username,
  avatar: profile.avatar
    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator||0)%5}.png`
})));
passport.serializeUser((u,d) => d(null,u));
passport.deserializeUser((u,d) => d(null,u));

// ── Auth ───────────────────────────────────────────────────────────
app.get('/auth/discord', (req, res, next) => {
  if (req.query.returnTo) req.session.returnTo = req.query.returnTo;
  passport.authenticate('discord')(req, res, next);
});
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: `${FRONTEND_URL}/?error=auth` }),
  (req, res) => {
    const userData = Buffer.from(JSON.stringify({
      id: req.user.id, username: req.user.username,
      displayName: req.user.displayName, avatar: req.user.avatar,
      isAdmin: isAdmin(req.user), isVipHost: isAdmin(req.user)||isVipHost(req.user)
    })).toString('base64');
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    // Encode returnTo as a query param so frontend can redirect after auth
    const returnParam = returnTo !== '/' ? `&returnTo=${encodeURIComponent(returnTo)}` : '';
    res.redirect(`${FRONTEND_URL}/?auth=${encodeURIComponent(userData)}${returnParam}`);
  }
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect(FRONTEND_URL)));
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { ...req.user, isAdmin: isAdmin(req.user), isVipHost: isAdmin(req.user)||isVipHost(req.user) } });
});

// ── State ──────────────────────────────────────────────────────────
const HUNTS_FILE   = path.join(__dirname, 'hunts_data.json');
const ARCHIVE_FILE = path.join(__dirname, 'hunts_archive.json');
const hunts   = {};
const archive = []; // completed hunts, newest first
const viewers = {};
let beanLive  = { isLive: false, title: '', updatedAt: null };

// Load persisted hunts on startup
try {
  if (fs.existsSync(HUNTS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(HUNTS_FILE, 'utf8'));
    Object.assign(hunts, saved);
    console.log(`[persist] Loaded ${Object.keys(hunts).length} hunts from disk`);
  }
} catch(e) { console.error('[persist] Failed to load hunts:', e.message); }

// Load archive on startup
try {
  if (fs.existsSync(ARCHIVE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
    archive.push(...saved);
    console.log(`[persist] Loaded ${archive.length} archived hunts`);
  }
} catch(e) { console.error('[persist] Failed to load archive:', e.message); }

function persistHunts() {
  try { fs.writeFileSync(HUNTS_FILE, JSON.stringify(hunts), 'utf8'); }
  catch(e) { console.error('[persist] Failed to save hunts:', e.message); }
}
function persistArchive() {
  try { fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive), 'utf8'); }
  catch(e) { console.error('[persist] Failed to save archive:', e.message); }
}
function archiveHunt(hunt) {
  if (!hunt || !hunt.user) return;
  // Save full hunt snapshot to archive (keep last 100)
  archive.unshift({ ...hunt, archivedAt: hunt.archivedAt || new Date().toISOString() });
  if (archive.length > 100) archive.splice(100);
  persistArchive();
}

function huntSummary(h) {
  return {
    userId: h.user.id, username: h.user.displayName, avatar: h.user.avatar,
    huntType: h.huntType, isLive: h.isLive, startedAt: h.startedAt, archivedAt: h.archivedAt||null,
    bonusCount: h.bonuses.length,
    totalWon: h.bonuses.reduce((s,b)=>s+b.win,0),
    pot: h.equity.reduce((s,e)=>s+e.amount,0),
    viewers: viewers[h.user.id]||0,
    huntMode: h.huntMode||'creating',
    rolledCount: (h.bonuses||[]).filter(b=>b.win>0).length,
  };
}
function getPublicHunts()   { return Object.values(hunts).filter(h=>h.isLive).map(huntSummary); }
function getArchivedHunts() { return archive.map(huntSummary); }
function getAllHunts()       { return Object.values(hunts).map(huntSummary); }
function emitHubUpdate()    { persistHunts(); io.emit('hub:update', getPublicHunts()); }
function emitHuntUpdate(userId) { const h = hunts[userId]; if (h) { persistHunts(); io.to(`hunt:${userId}`).emit('hunt:update', h); } }

function requireAuth(req, res, next)  { if (!req.user) return res.status(401).json({error:'Not authenticated'}); next(); }
function requireAdmin(req, res, next) { if (!req.user||!isAdmin(req.user)) return res.status(403).json({error:'Admin only'}); next(); }
function uid() { return Math.random().toString(36).slice(2, 8); }

// ── Public hunt endpoints ──────────────────────────────────────────
app.get('/api/hunts',          (req, res) => res.json(getPublicHunts()));
app.get('/api/hunts/archived', (req, res) => res.json(getArchivedHunts()));

app.get('/api/hunts/:userId', (req, res) => {
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  if (!hunt.isLive && !hunt.archivedAt && !(req.user && canEditHunt(req.user, req.params.userId)))
    return res.status(404).json({error:'Hunt not live'});
  const canEdit  = req.user ? canEditHunt(req.user, req.params.userId) : false;

  // Auto-link: when a logged-in viewer visits, match their Discord name to an equity entry and store their ID
  if (req.user?.id && hunt.equity) {
    const vName = nameOf(req.user);
    const vNoSp = vName.replace(/\s+/g,'');
    let linked = false;
    hunt.equity = hunt.equity.map(e => {
      if (e.discordId) return e;
      const en = (e.name||'').toLowerCase().trim();
      const enNoSp = en.replace(/\s+/g,'');
      if (en===vName||enNoSp===vNoSp||en===vNoSp||enNoSp===vName) {
        linked = true;
        return { ...e, discordId: req.user.id, name: req.user.displayName || e.name };
      }
      return e;
    });
    if (linked) emitHuntUpdate(req.params.userId);
  }

  const canCalls = req.user ? (canEdit || isEquityMember(req.user, req.params.userId)) : false;
  res.json({ ...hunt, canEdit, canAddCalls: canCalls });
});

// ── My hunt ────────────────────────────────────────────────────────
app.get('/api/my-hunt', requireAuth, (req, res) => res.json(hunts[req.user.id] || null));

app.post('/api/my-hunt/start', requireAuth, (req, res) => {
  const { huntType = 'community' } = req.body;
  if (huntType === 'vip' && !isAdmin(req.user) && !isVipHost(req.user))
    return res.status(403).json({error:'Not authorised for VIP hunts'});
  // Archive previous hunt if it had any bonuses
  if (hunts[req.user.id] && hunts[req.user.id].bonuses?.length > 0) {
    if (!hunts[req.user.id].archivedAt) hunts[req.user.id].archivedAt = new Date().toISOString();
    archiveHunt(hunts[req.user.id]);
  }
  hunts[req.user.id] = {
    user: req.user, isLive: false, startedAt: null, archivedAt: null,
    huntType, bonuses: [], equity: huntType==='vip'?[{id:'bean_auto',name:'Bean',amount:1000,isRollWinner:false}]:[], calls: [], invitedEditors: [], callLimit: 0, huntMode: 'creating'
  };
  persistHunts();
  res.json({ok:true});
});

app.post('/api/my-hunt/golive', requireAuth, (req, res) => {
  if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
  hunts[req.user.id].isLive    = true;
  hunts[req.user.id].startedAt = new Date().toISOString();
  hunts[req.user.id].archivedAt= null;
  emitHubUpdate(); // emitHubUpdate calls persistHunts
  io.to(`hunt:${req.user.id}`).emit('hunt:update', hunts[req.user.id]);
  res.json({ok:true});
});

app.post('/api/my-hunt/end', requireAuth, (req, res) => {
  if (hunts[req.user.id]) {
    hunts[req.user.id].isLive    = false;
    hunts[req.user.id].archivedAt= new Date().toISOString();
    archiveHunt(hunts[req.user.id]);
    emitHubUpdate();
    io.to(`hunt:${req.user.id}`).emit('hunt:update', hunts[req.user.id]);
  }
  res.json({ok:true});
});

app.post('/api/my-hunt/reset', requireAuth, (req, res) => {
  // Archive the hunt before wiping it
  if (hunts[req.user.id] && hunts[req.user.id].bonuses?.length > 0) {
    if (!hunts[req.user.id].archivedAt) hunts[req.user.id].archivedAt = new Date().toISOString();
    archiveHunt(hunts[req.user.id]);
  }
  hunts[req.user.id] = { user: req.user, isLive: false, startedAt: null, archivedAt: null,
    huntType: 'community', bonuses: [], equity: [], calls: [], invitedEditors: [], callLimit: 0, huntMode: 'creating' };
  persistHunts();
  emitHubUpdate();
  res.json({ok:true});
});

app.put('/api/my-hunt', requireAuth, (req, res) => {
  if (!hunts[req.user.id]) hunts[req.user.id] = {
    user: req.user, isLive: false, startedAt: null, archivedAt: null,
    huntType: 'community', bonuses: [], equity: [], calls: [], invitedEditors: [], callLimit: 0
  };
  const { bonuses, equity, calls, huntType, callLimit, huntMode, roundRobin } = req.body;
  if (bonuses    !== undefined) hunts[req.user.id].bonuses    = bonuses;
  if (equity     !== undefined) hunts[req.user.id].equity     = equity;
  if (calls      !== undefined) hunts[req.user.id].calls      = calls;
  if (huntType   !== undefined) {
    if (huntType === 'vip' && !isAdmin(req.user) && !isVipHost(req.user))
      return res.status(403).json({error:'Not authorised for VIP hunt'});
    hunts[req.user.id].huntType = huntType;
  }
  if (callLimit  !== undefined) hunts[req.user.id].callLimit  = callLimit;
  if (huntMode   !== undefined) hunts[req.user.id].huntMode   = huntMode;
  if (roundRobin !== undefined) hunts[req.user.id].roundRobin = roundRobin;
  persistHunts();
  io.to(`hunt:${req.user.id}`).emit('hunt:update', hunts[req.user.id]);
  emitHubUpdate();
  res.json({ok:true});
});

// ── Invite editor ──────────────────────────────────────────────────
app.post('/api/my-hunt/invite', requireAuth, (req, res) => {
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

app.delete('/api/my-hunt/invite', requireAuth, (req, res) => {
  const { username } = req.body;
  if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
  hunts[req.user.id].invitedEditors = (hunts[req.user.id].invitedEditors||[])
    .filter(u => u !== username.toLowerCase().trim());
  io.to(`hunt:${req.user.id}`).emit('hunt:reinvite', { huntUserId: req.user.id });
  res.json({ok:true, invitedEditors: hunts[req.user.id].invitedEditors});
});

// ── Equity member: add slot call ────────────────────────────────────
app.post('/api/hunts/:userId/calls', requireAuth, (req, res) => {
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  if (!canEditHunt(req.user, req.params.userId) && !isEquityMember(req.user, req.params.userId))
    return res.status(403).json({error:'Not an equity member'});

  const { slot } = req.body;
  if (!slot?.trim()) return res.status(400).json({error:'Slot name required'});

  // Block equity members (non-editors) from adding calls when rolling
  if (hunt.huntMode === 'rolling' && !canEditHunt(req.user, req.params.userId))
    return res.status(403).json({error:'Cannot add calls while the hunt is rolling'});

  // Duplicate check
  if (hunt.calls.some(c => c.slot.toLowerCase().trim() === slot.toLowerCase().trim()))
    return res.status(400).json({error:`"${slot}" is already in the queue`});

  // Per-person limit (not applied to hunt owner or admins)
  const callerName = nameOf(req.user);
  if (hunt.callLimit > 0 && !canEditHunt(req.user, req.params.userId)) {
    const myCount = hunt.calls.filter(c => c.user.toLowerCase() === callerName).length;
    if (myCount >= hunt.callLimit)
      return res.status(400).json({error:`You've reached the limit of ${hunt.callLimit} calls`});
  }

  const newCall = { id: Math.random().toString(36).slice(2,8), slot: slot.trim(), user: req.user.displayName||req.user.username, status: 'pending' };
  // Insert after first 3 pending calls so top 3 stay stable
  const pendingCalls = hunt.calls.filter(c=>c.status==='pending');
  const otherCalls   = hunt.calls.filter(c=>c.status!=='pending');
  const insertAt     = Math.min(3, pendingCalls.length);
  pendingCalls.splice(insertAt, 0, newCall);
  hunt.calls = [...pendingCalls, ...otherCalls];
  persistHunts();
  io.to(`hunt:${req.params.userId}`).emit('hunt:update', hunt);
  res.json({ok:true, call: newCall});
});

// ── Edit any hunt (admin/editor) ───────────────────────────────────
app.put('/api/hunts/:userId', requireAuth, (req, res) => {
  if (!canEditHunt(req.user, req.params.userId)) return res.status(403).json({error:'Not authorised'});
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  const { bonuses, equity, calls, huntType, callLimit, huntMode, roundRobin } = req.body;
  if (bonuses     !== undefined) hunt.bonuses     = bonuses;
  if (equity      !== undefined) hunt.equity      = equity;
  if (calls       !== undefined) hunt.calls       = calls;
  if (huntType    !== undefined) hunt.huntType    = huntType;
  if (callLimit   !== undefined) hunt.callLimit   = callLimit;
  if (huntMode    !== undefined) hunt.huntMode    = huntMode;
  if (roundRobin  !== undefined) hunt.roundRobin  = roundRobin;
  persistHunts();
  io.to(`hunt:${req.params.userId}`).emit('hunt:update', hunt);
  emitHubUpdate();
  res.json({ok:true});
});

// ── Admin ──────────────────────────────────────────────────────────
app.get('/api/admin/hunts', requireAdmin, (req, res) => res.json(getAllHunts()));

app.post('/api/admin/hunts/:userId/end', requireAdmin, (req, res) => {
  const h = hunts[req.params.userId];
  if (!h) return res.status(404).json({error:'Not found'});
  h.isLive = false; h.archivedAt = new Date().toISOString();
  archiveHunt(h);
  emitHubUpdate(); io.to(`hunt:${req.params.userId}`).emit('hunt:update', h);
  res.json({ok:true});
});

app.delete('/api/admin/hunts/:userId', requireAdmin, (req, res) => {
  if (!hunts[req.params.userId]) return res.status(404).json({error:'Not found'});
  delete hunts[req.params.userId]; emitHubUpdate();
  res.json({ok:true});
});

// ── User Settings ──────────────────────────────────────────────────
// ── User Settings (Postgres-backed) ───────────────────────────────
// Falls back to in-memory if DATABASE_URL not set
const { Pool } = require('pg');
let pgPool = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pgPool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL DEFAULT '{}'
    )
  `).then(() => console.log('[settings] Postgres table ready'))
    .catch(e => { console.error('[settings] Postgres init failed:', e.message); pgPool = null; });
} else {
  console.log('[settings] No DATABASE_URL — using in-memory settings (will reset on redeploy)');
}

const SETTINGS_FILE = path.join(__dirname, 'user_settings.json');
let userSettings = {};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    console.log(`[settings] Loaded ${Object.keys(userSettings).length} users from file`);
  }
} catch(e) { console.error('[settings] Failed to load user_settings.json:', e.message); }

async function getSettings(userId) {
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT settings FROM user_settings WHERE user_id=$1', [userId]);
      return r.rows[0]?.settings || { rainbetName: '', preferredSlots: [] };
    } catch(e) { console.error('[settings] pg getSettings error:', e.message); }
  }
  return userSettings[userId] || { rainbetName: '', preferredSlots: [] };
}

async function saveSettings(userId, data) {
  if (pgPool) {
    try {
      await pgPool.query(
        'INSERT INTO user_settings(user_id, settings) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET settings=$2',
        [userId, JSON.stringify(data)]
      );
      return;
    } catch(e) { console.error('[settings] pg saveSettings error:', e.message); }
  }
  // Fallback to file
  userSettings[userId] = data;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings), 'utf8'); } catch(e) {}
}

// GET /api/settings — get current user's settings
app.get('/api/settings', requireAuth, async (req, res) => {
  res.json(await getSettings(req.user.id));
});

// PUT /api/settings — save current user's settings
app.put('/api/settings', requireAuth, async (req, res) => {
  const current = await getSettings(req.user.id);
  const { rainbetName, preferredSlots } = req.body;
  if (rainbetName !== undefined)    current.rainbetName    = String(rainbetName).trim().slice(0, 64);
  if (preferredSlots !== undefined) current.preferredSlots = (preferredSlots || []).slice(0, 8);
  await saveSettings(req.user.id, current);
  res.json({ ok: true, settings: current });
});

// GET /api/settings/:userId — get another user's preferred slots by Discord ID
app.get('/api/settings/:userId', requireAuth, async (req, res) => {
  const s = await getSettings(req.params.userId);
  res.json({ preferredSlots: s.preferredSlots || [] });
});



app.post('/api/tickets', async (req, res) => {
  const { username, issue, type } = req.body;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return res.status(500).json({error:'Bot token not configured'});
  try {
    // Open DM channel with Randy
    const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${botToken}` },
      body: JSON.stringify({ recipient_id: RANDY_DISCORD_ID })
    });
    const dmData = await dmRes.json();
    if (!dmData.id) throw new Error('Could not open DM channel');

    // Send message
    await fetch(`https://discord.com/api/v10/channels/${dmData.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bot ${botToken}` },
      body: JSON.stringify({
        embeds: [{
          title: `🎫 Ticket — ${type||'General'}`,
          description: issue,
          color: 0xf5a500,
          fields: [{ name: 'From', value: username||'Anonymous', inline: true }],
          timestamp: new Date().toISOString()
        }]
      })
    });
    res.json({ok:true});
  } catch(e) { console.error('Ticket error:', e.message); res.status(500).json({error:'Failed to send ticket'}); }
});

// ── Twitch live check ──────────────────────────────────────────────
async function checkBeanLive() {
  const cid = process.env.TWITCH_CLIENT_ID;
  const sec = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !sec) return;
  try {
    const tr = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${cid}&client_secret=${sec}&grant_type=client_credentials`
    });
    const td = await tr.json();
    const sr = await fetch('https://api.twitch.tv/helix/streams?user_login=bean', {
      headers: { 'Client-ID': cid, 'Authorization': `Bearer ${td.access_token}` }
    });
    const sd = await sr.json();
    beanLive = { isLive: !!(sd.data?.length), title: sd.data?.[0]?.title||'', updatedAt: new Date().toISOString() };
    io.emit('bean:live', beanLive);
  } catch(e) { console.error('Twitch check error:', e.message); }
}
checkBeanLive();
setInterval(checkBeanLive, 5 * 60 * 1000);

app.get('/api/bean-live', (req, res) => res.json(beanLive));

// ── Health ─────────────────────────────────────────────────────────

// ── Discord Import ────────────────────────────────────────────────
const DISCORD_BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN || '';
const DISCORD_CALLS_CHANNEL   = process.env.DISCORD_CALLS_CHANNEL_ID || '';
const DISCORD_WINNERS_CHANNEL = process.env.DISCORD_WINNERS_CHANNEL_ID || '';

async function fetchDiscordMessages(channelId, limit = 100) {
  if (!DISCORD_BOT_TOKEN || !channelId) throw new Error('Discord bot not configured');
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`Discord API error: ${res.status}`);
  return res.json();
}

// Import slot calls from last 20 mins — anyone in the channel
app.get('/api/discord/import-calls', requireAuth, async (req, res) => {
  try {
    const hunt = hunts[req.user.id];
    if (!hunt) return res.status(404).json({ error: 'No active hunt' });

    const messages = await fetchDiscordMessages(DISCORD_CALLS_CHANNEL, 100);
    const cutoff   = Date.now() - 20 * 60 * 1000;
    const recent = messages.filter(m => new Date(m.timestamp).getTime() > cutoff);

    // Both hunt types: only import calls from equity members
    const equityNames = (hunt.equity || []).filter(e => e.name).map(e => e.name.toLowerCase().trim());

    const imported = [];
    const existingSlots = new Set((hunt.calls || []).map(c => (c.slot||'').toLowerCase().trim()));

    for (const msg of recent) {
      const callerName = msg.member?.nick || msg.author?.global_name || msg.author?.username || '';
      const author     = (msg.author?.username || '').toLowerCase().trim();
      const nick       = (msg.member?.nick || '').toLowerCase().trim();
      const globalName = (msg.author?.global_name || '').toLowerCase().trim();
      const inEquity   = equityNames.some(n =>
        n === author || n === nick || n === globalName ||
        author.includes(n) || nick.includes(n) || n.includes(author)
      );
      if (!inEquity) continue;

      // Strip @mentions and leading/trailing whitespace from content
      let content = msg.content
        .replace(/<@!?\d+>/g, '')   // strip discord @mentions
        .replace(/@\w+/g, '')       // strip plain @mentions
        .trim();

      if (!content) continue;

      // Split by comma or newline — each part is a slot call
      const parts = content.split(/[,\n]/).map(p => p.trim()).filter(p => p.length > 1 && p.length < 80);

      for (const part of parts) {
        const slotName = part.replace(/^[#\-•*\d.]+\s*/, '').trim();
        if (slotName && !existingSlots.has(slotName.toLowerCase())) {
          imported.push({
            id: `dc_${msg.id}_${imported.length}`,
            slot: slotName,
            caller: callerName,
            status: 'pending',
            source: 'discord'
          });
          existingSlots.add(slotName.toLowerCase());
        }
      }
    }

    res.json({ imported, count: imported.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Parse VIP winners from Discord — finds latest results message and extracts names
app.get('/api/discord/parse-winners', requireAuth, async (req, res) => {
  try {
    const messages = await fetchDiscordMessages(DISCORD_WINNERS_CHANNEL, 50);

    // Find the most recent message containing winner results (has "#1" and "Checked-In")
    const resultsMsg = messages.find(m =>
      m.content.includes('Checked-In') && m.content.includes('#1')
    );
    if (!resultsMsg) return res.json({ winners: [], count: 0, raw: 'No results message found in last 50 messages' });

    // Parse lines like: #1    Jaycsk    144.949925    +45    Checked-In
    const winners = [];
    const lines = resultsMsg.content.split('\n');
    for (const line of lines) {
      const match = line.match(/^#(\d+)\s+(.+?)\s+(\d+\.\d+)\s+([+-]?\d+)/);
      if (match) {
        winners.push({
          place: parseInt(match[1]),
          name:  match[2].trim(),
          roll:  parseFloat(match[3]),
          luck:  parseInt(match[4]),
        });
      }
    }

    res.json({ winners, count: winners.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Slot Autocomplete ─────────────────────────────────────────────
let slotCache = { games: [], thumbMap: {}, fetchedAt: 0 };

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
const SOFTSWISS_HITS_FILE = path.join(__dirname, 'softswiss_hits.json');
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

// Pre-fetch on startup
getSlotGames().catch(() => {});

// Image proxy — serves CORS-blocked thumbnails (e.g. pragmaticplay.com) through our backend
const imgProxyCache = new Map(); // url -> {buf, ct, at}
const IMG_PROXY_TTL = 24 * 60 * 60 * 1000; // 24 hours
const ALLOWED_IMG_HOSTS = ['www.pragmaticplay.com', 'pragmaticplay.com', 'cdn.softswiss.net', 'cdn.rainbet.com', 'slot.report', 'www.thunderkick.com', 'static.wixstatic.com'];

app.get('/api/img-proxy', async (req, res) => {
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
});

app.get('/api/slots/search', async (req, res) => {
  const q     = (req.query.q || '').toLowerCase().trim();
  const limit = parseInt(req.query.limit) || 20;
  const { games, thumbMap } = await getSlotGames();

  // Build full mapped list once and cache it
  if (!getSlotGames._mappedCache || getSlotGames._mappedCacheAt !== slotCache.fetchedAt) {
    getSlotGames._mappedCache = games.map(g => {
      let thumb = thumbMap[g.slug] || null;
      if (!thumb) thumb = SOFTSWISS_HITS[g.slug] || null;
      if (thumb && (thumb.includes('pragmaticplay.com') || thumb.includes('wixstatic.com'))) {
        thumb = `/api/img-proxy?url=${encodeURIComponent(thumb)}`;
      }
      return { name: g.name, slug: g.slug, provider: g.provider_slug || '', thumb };
    });
    getSlotGames._mappedCacheAt = slotCache.fetchedAt;
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
});

app.get('/api/health', (req, res) => res.json({ok:true}));

// ── Call Permission Requests ─────────────────────────────────────
// Store pending requests per hunt
// huntCallRequests[huntOwnerId] = [{id, userId, displayName, avatar, requestedAt}]
const huntCallRequests = {};

// Request permission to add calls
app.post('/api/hunts/:userId/request-calls', requireAuth, (req, res) => {
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
app.get('/api/hunts/:userId/call-requests', requireAuth, (req, res) => {
  if (req.user.id !== req.params.userId && !isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  res.json(huntCallRequests[req.params.userId] || []);
});

// Grant or deny a request
app.post('/api/hunts/:userId/call-requests/:requestId', requireAuth, (req, res) => {
  const { userId, requestId } = req.params;
  const { action } = req.body; // 'grant' or 'deny'
  if (req.user.id !== userId && !isAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });

  const requests = huntCallRequests[userId] || [];
  const reqItem = requests.find(r => r.id === requestId);
  if (!reqItem) return res.status(404).json({ error: 'Request not found' });

  // Remove from pending
  huntCallRequests[userId] = requests.filter(r => r.id !== requestId);

  if (action === 'grant') {
    // Add to invitedEditors as calls-only
    if (!hunts[userId].callsPermissions) hunts[userId].callsPermissions = [];
    if (!hunts[userId].callsPermissions.includes(reqItem.userId)) {
      hunts[userId].callsPermissions.push(reqItem.userId);
    }
    // Notify the requester
    io.to(`hunt:${userId}`).emit('calls:granted', { userId: reqItem.userId });
  } else {
    io.to(`hunt:${userId}`).emit('calls:denied', { userId: reqItem.userId });
  }

  // Update owner's notification count
  io.to(`hunt:${userId}`).emit('calls:request:update', { requests: huntCallRequests[userId] });
  res.json({ ok: true });
});

// ── Socket.io ─────────────────────────────────────────────────────
// Track socket → { watchingHuntId, user } for permission-aware updates
const socketUsers = {};

io.on('connection', socket => {
  socket.on('watch:hub', () => {
    socket.join('hub');
    socket.emit('hub:update', getPublicHunts());
    socket.emit('bean:live', beanLive);
  });

  socket.on('watch:hunt', userId => {
    socket.join(`hunt:${userId}`);
    socketUsers[socket.id] = { watchingHuntId: userId };
    viewers[userId] = (viewers[userId]||0) + 1;
    const h = hunts[userId];
    if (h) socket.emit('hunt:update', h);
    emitHubUpdate();
    socket.on('disconnect', () => {
      viewers[userId] = Math.max(0,(viewers[userId]||1)-1);
      delete socketUsers[socket.id];
      emitHubUpdate();
    });
  });

  socket.on('leave:hunt', userId => {
    socket.leave(`hunt:${userId}`);
    if (viewers[userId]) viewers[userId] = Math.max(0, viewers[userId] - 1);
    emitHubUpdate();
  });

  // Client sends their user id so we can compute canEdit for them
  socket.on('identify', (userId) => {
    if (socketUsers[socket.id]) socketUsers[socket.id].userId = userId;
  });

  // On reinvite, socket re-fetches permissions from the API
  // (handled client-side in WatchHunt)
});

server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
