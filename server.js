const express         = require('express');
const session         = require('express-session');
const passport        = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors            = require('cors');
const http            = require('http');
const { Server }      = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }
});

const PORT           = process.env.PORT || 3001;
const FRONTEND_URL   = process.env.FRONTEND_URL || 'http://localhost:3000';

// Allow both FRONTEND_URL and common Vercel domains
const corsOrigin = (origin, callback) => {
  const allowedOrigins = [
    FRONTEND_URL,
    'https://twitchbean-hunt.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
  ];
  if (!origin || allowedOrigins.includes(origin)) {
    callback(null, true);
  } else {
    callback(new Error('Not allowed by CORS'));
  }
};

app.use(cors({ origin: corsOrigin, credentials: true }));
const SESSION_SECRET = process.env.SESSION_SECRET || 'beanhunt-secret';
const ADMINS         = (process.env.ADMINS || 'bean,randycabbage,randy cabbage,mcflury,mihallimou,missingiscool,cuda,birdvision').toLowerCase().split(',').map(s=>s.trim());
const VIP_HOSTS      = (process.env.VIP_HOSTS || 'bean,mcflury,mihallimou,missingiscool,cuda,randycabbage').toLowerCase().split(',').map(s=>s.trim());

function nameOf(user) { return (user?.displayName || user?.username || '').toLowerCase().trim(); }
function isAdmin(user) { return user ? ADMINS.includes(nameOf(user)) : false; }
function canEditHunt(user, huntOwnerId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (user.id === huntOwnerId) return true;
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  const name = nameOf(user);
  const invites = hunt.invitedEditors || [];
  return invites.includes(name) || invites.includes(user.id);
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
      isAdmin: isAdmin(req.user), isVipHost: isAdmin(req.user)||VIP_HOSTS.includes(nameOf(req.user))
    })).toString('base64');
    const returnTo = req.session?.returnTo || '/hunt';
    delete req.session?.returnTo;
    const safePath = returnTo.startsWith('/') ? returnTo : '/hunt';
    res.redirect(`${FRONTEND_URL}${safePath}?auth=${encodeURIComponent(userData)}`);
  }
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect(FRONTEND_URL)));
app.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { ...req.user, isAdmin: isAdmin(req.user), isVipHost: isAdmin(req.user)||VIP_HOSTS.includes(nameOf(req.user)) } });
});

// ── State ──────────────────────────────────────────────────────────
const hunts   = {};
const viewers = {};
let beanLive  = { isLive: false, title: '', updatedAt: null };

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
function getPublicHunts()  { return Object.values(hunts).filter(h=>h.isLive).map(huntSummary); }
function getAllHunts()      { return Object.values(hunts).map(huntSummary); }
function emitHubUpdate()   { io.emit('hub:update', getPublicHunts()); }

function requireAuth(req, res, next)  { if (!req.user) return res.status(401).json({error:'Not authenticated'}); next(); }
function requireAdmin(req, res, next) { if (!req.user||!isAdmin(req.user)) return res.status(403).json({error:'Admin only'}); next(); }

// ── Public hunt endpoints ──────────────────────────────────────────
app.get('/api/hunts', (req, res) => res.json(getPublicHunts()));

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
  if (huntType === 'vip' && !isAdmin(req.user) && !VIP_HOSTS.includes(nameOf(req.user)))
    return res.status(403).json({error:'Not authorised for VIP hunts'});
  hunts[req.user.id] = {
    user: req.user, isLive: false, startedAt: null, archivedAt: null,
    huntType, bonuses: [], equity: huntType==='vip'?[{id:'bean_auto',name:'Bean',amount:1000,isRollWinner:false}]:[], calls: [], invitedEditors: [], callLimit: 0, huntMode: 'creating'
  };
  res.json({ok:true});
});

app.post('/api/my-hunt/golive', requireAuth, (req, res) => {
  if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
  hunts[req.user.id].isLive    = true;
  hunts[req.user.id].startedAt = new Date().toISOString();
  hunts[req.user.id].archivedAt= null;
  emitHubUpdate();
  io.to(`hunt:${req.user.id}`).emit('hunt:update', hunts[req.user.id]);
  res.json({ok:true});
});

app.post('/api/my-hunt/end', requireAuth, (req, res) => {
  if (hunts[req.user.id]) {
    hunts[req.user.id].isLive    = false;
    hunts[req.user.id].archivedAt= new Date().toISOString();
    emitHubUpdate();
    io.to(`hunt:${req.user.id}`).emit('hunt:update', hunts[req.user.id]);
  }
  res.json({ok:true});
});

app.post('/api/my-hunt/reset', requireAuth, (req, res) => {
  hunts[req.user.id] = { user: req.user, isLive: false, startedAt: null, archivedAt: null,
    huntType: 'community', bonuses: [], equity: [], calls: [], invitedEditors: [], callLimit: 0, huntMode: 'creating' };
  emitHubUpdate();
  res.json({ok:true});
});

app.put('/api/my-hunt', requireAuth, (req, res) => {
  if (!hunts[req.user.id]) hunts[req.user.id] = {
    user: req.user, isLive: false, startedAt: null, archivedAt: null,
    huntType: 'community', bonuses: [], equity: [], calls: [], invitedEditors: [], callLimit: 0
  };
  const { bonuses, equity, calls, huntType, callLimit, huntMode } = req.body;
  if (bonuses   !== undefined) hunts[req.user.id].bonuses   = bonuses;
  if (equity    !== undefined) hunts[req.user.id].equity    = equity;
  if (calls     !== undefined) hunts[req.user.id].calls     = calls;
  if (huntType  !== undefined) {
    if (huntType === 'vip' && !isAdmin(req.user) && !VIP_HOSTS.includes(nameOf(req.user)))
      return res.status(403).json({error:'Not authorised for VIP hunt'});
    hunts[req.user.id].huntType = huntType;
  }
  if (callLimit !== undefined) hunts[req.user.id].callLimit = callLimit;
  if (huntMode  !== undefined) hunts[req.user.id].huntMode  = huntMode;
  io.to(`hunt:${req.user.id}`).emit('hunt:update', hunts[req.user.id]);
  emitHubUpdate();
  res.json({ok:true});
});

// ── Invite editor ──────────────────────────────────────────────────
app.post('/api/my-hunt/invite', requireAuth, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({error:'username required'});
  if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
  const lower = username.toLowerCase().trim();
  if (!hunts[req.user.id].invitedEditors) hunts[req.user.id].invitedEditors = [];
  if (!hunts[req.user.id].invitedEditors.includes(lower))
    hunts[req.user.id].invitedEditors.push(lower);
  // Tell everyone watching this hunt to re-fetch their permissions
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
  io.to(`hunt:${req.params.userId}`).emit('hunt:update', hunt);
  res.json({ok:true, call: newCall});
});

// ── Edit any hunt (admin/editor) ───────────────────────────────────
app.put('/api/hunts/:userId', requireAuth, (req, res) => {
  if (!canEditHunt(req.user, req.params.userId)) return res.status(403).json({error:'Not authorised'});
  const hunt = hunts[req.params.userId];
  if (!hunt) return res.status(404).json({error:'Hunt not found'});
  const { bonuses, equity, calls, huntType, callLimit, huntMode } = req.body;
  if (bonuses   !== undefined) hunt.bonuses   = bonuses;
  if (equity    !== undefined) hunt.equity    = equity;
  if (calls     !== undefined) hunt.calls     = calls;
  if (huntType  !== undefined) hunt.huntType  = huntType;
  if (callLimit !== undefined) hunt.callLimit = callLimit;
  if (huntMode  !== undefined) hunt.huntMode  = huntMode;
  io.to(`hunt:${req.params.userId}`).emit('hunt:update', hunt);
  emitHubUpdate();
  res.json({ok:true});
});

// ── Admin ──────────────────────────────────────────────────────────
app.get('/api/admin/hunts', requireAdmin, (req, res) => res.json(getAllHunts()));

// Mitch's hunt data storage
let mitchHunts = [];

// Cdew's hunt data storage  
let cdewHunts = [];

// Fetch Mitch hunts from mitchjones.vip API (server-to-server, no CSP)
app.post('/api/admin/fetch-and-import-mitch-hunts', async (req, res) => {
  try {
    const allHunts = [];
    
    // Fetch all pages from mitchjones API (page 0 has completed hunts too)
    for (let page = 0; page < 20; page++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(`https://mitchjones.vip/api/bonus-hunt/list?page=${page}`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          console.log(`Page ${page}: Status ${response.status}, breaking`);
          break;
        }
        
        const data = await response.json();
        
        // API returns { data: [{ name, bonuses: [...] }, ...] }
        const huntSessions = data.data || [];
        
        if (!Array.isArray(huntSessions) || huntSessions.length === 0) {
          console.log(`Page ${page}: No hunt sessions, breaking`);
          break;
        }
        
        let pageHunts = 0;
        
        // Extract bonuses from each hunt session
        huntSessions.forEach(session => {
          if (!session.bonuses || !Array.isArray(session.bonuses)) return;
          
          // Extract hunt starting amount (the buyin for the entire hunt session)
          // Round to nearest 1000 - Mitch always starts with round amounts
          const huntStartAmount = Math.round(parseFloat(session.infoStartCost) / 1000) * 1000 || 0;
          
          const transformed = session.bonuses.map(bonus => ({
            slot: bonus.slot?.title || bonus.name || 'Unknown',
            bet: parseFloat(bonus.betSize) || 0,
            win: parseFloat(bonus.payout) || 0,
            requiredMultiplier: parseFloat(bonus.multiplier) || 0,  // Target multiplier from API
            multiplier: bonus.payout && bonus.betSize ? parseFloat((bonus.payout / bonus.betSize).toFixed(2)) : 0,  // Earned multiplier
            provider: bonus.slot?.provider || '',
            date: new Date().toISOString()
          }));
          
          // Only keep bonuses with actual bets
          const valid = transformed.filter(t => t.bet > 0);
          if (valid.length > 0) {
            pageHunts += valid.length;
            allHunts.push({
              date: new Date().toISOString(),
              huntStart: huntStartAmount,  // Store the hunt's starting amount (buyin)
              bonuses: valid
            });
          }
        });
        
        console.log(`Page ${page}: Extracted ${pageHunts} valid bonuses`);
      } catch (pageErr) {
        if (pageErr.name === 'AbortError') {
          console.error(`Page ${page}: Fetch timeout`);
        } else {
          console.error(`Page ${page}: ${pageErr.message}`);
        }
        break;
      }
    }
    
    console.log(`Total hunts fetched: ${allHunts.length}`);
    
    // Now import using the existing import logic
    mitchHunts = allHunts;
    
    // Calculate aggregate slot stats
    const stats = {};
    
    allHunts.forEach(hunt => {
      if (!hunt.bonuses || !Array.isArray(hunt.bonuses)) return;
      
      hunt.bonuses.forEach(bonus => {
        const slotName = bonus.slot || 'Unknown';
        
        if (!stats[slotName]) {
          stats[slotName] = {
            name: slotName,
            totalBets: 0,
            totalWins: 0,
            bonusCount: 0,
            wins: 0,
            losses: 0,
            totalWinnings: 0,
            multipliers: []
          };
        }
        
        stats[slotName].bonusCount += 1;
        stats[slotName].totalBets += bonus.bet || 0;
        
        if (bonus.win && bonus.win > 0) {
          stats[slotName].wins += 1;
          stats[slotName].totalWins += bonus.win;
          stats[slotName].totalWinnings += (bonus.win - (bonus.bet || 0));
          if (bonus.multiplier) stats[slotName].multipliers.push(bonus.multiplier);
        } else {
          stats[slotName].losses += 1;
          stats[slotName].totalWinnings -= (bonus.bet || 0);
        }
      });
    });
    
    // Calculate metrics
    Object.values(stats).forEach(stat => {
      stat.avgMultiplier = stat.multipliers.length > 0 
        ? (stat.multipliers.reduce((a, b) => a + b, 0) / stat.multipliers.length).toFixed(2)
        : 0;
      stat.roi = stat.totalBets > 0 
        ? ((stat.totalWinnings / stat.totalBets) * 100).toFixed(1)
        : 0;
      stat.winRate = stat.bonusCount > 0
        ? ((stat.wins / stat.bonusCount) * 100).toFixed(1)
        : 0;
    });
    
    res.json({
      ok: true,
      huntsImported: allHunts.length,
      totalBonuses: allHunts.reduce((sum, h) => sum + (h.bonuses?.length || 0), 0),
      uniqueSlots: Object.keys(stats).length,
      slotStats: stats
    });
  } catch (err) {
    console.error('Error fetching Mitch hunts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/import-mitch-hunts', requireAdmin, (req, res) => {
  const { hunts: incomingHunts } = req.body;
  
  if (!Array.isArray(incomingHunts)) {
    return res.status(400).json({error: 'Invalid format. Expected {hunts: [...]}'});
  }
  
  // Store the hunts
  mitchHunts = incomingHunts;
  
  // Calculate aggregate slot stats
  const stats = {};
  
  incomingHunts.forEach(hunt => {
    if (!hunt.bonuses || !Array.isArray(hunt.bonuses)) return;
    
    hunt.bonuses.forEach(bonus => {
      const slotName = bonus.slot || 'Unknown';
      
      if (!stats[slotName]) {
        stats[slotName] = {
          name: slotName,
          totalBets: 0,
          totalWins: 0,
          bonusCount: 0,
          wins: 0,
          losses: 0,
          totalWinnings: 0,
          multipliers: []
        };
      }
      
      stats[slotName].bonusCount += 1;
      stats[slotName].totalBets += bonus.bet || 0;
      
      if (bonus.win && bonus.win > 0) {
        stats[slotName].wins += 1;
        stats[slotName].totalWins += bonus.win;
        stats[slotName].totalWinnings += (bonus.win - (bonus.bet || 0));
        if (bonus.multiplier) stats[slotName].multipliers.push(bonus.multiplier);
      } else {
        stats[slotName].losses += 1;
        stats[slotName].totalWinnings -= (bonus.bet || 0);
      }
    });
  });
  
  // Calculate metrics
  Object.values(stats).forEach(stat => {
    stat.avgMultiplier = stat.multipliers.length > 0 
      ? (stat.multipliers.reduce((a, b) => a + b, 0) / stat.multipliers.length).toFixed(2)
      : 0;
    stat.roi = stat.totalBets > 0 
      ? ((stat.totalWinnings / stat.totalBets) * 100).toFixed(1)
      : 0;
    stat.winRate = stat.bonusCount > 0
      ? ((stat.wins / stat.bonusCount) * 100).toFixed(1)
      : 0;
  });
  
  res.json({
    ok: true,
    huntsImported: incomingHunts.length,
    totalBonuses: incomingHunts.reduce((sum, h) => sum + (h.bonuses?.length || 0), 0),
    uniqueSlots: Object.keys(stats).length,
    slotStats: stats
  });
});

app.get('/api/admin/mitch-hunts', (req, res) => {
  res.json({hunts: mitchHunts, count: mitchHunts.length});
});

app.post('/api/admin/fetch-and-import-cdew-hunts', async (req, res) => {
  try {
    const response = await fetch('https://api.cdew.gg/api/bonus-hunts');
    const data = await response.json();
    
    if (!data.success) return res.status(400).json({error: 'Failed to fetch Cdew data'});
    
    const allHunts = [];
    const huntsToProcess = [];
    if (data.active && data.active.bonuses) huntsToProcess.push(data.active);
    if (Array.isArray(data.history)) huntsToProcess.push(...data.history);
    
    huntsToProcess.forEach(hunt => {
      if (!hunt.bonuses || !Array.isArray(hunt.bonuses)) return;
      const transformed = hunt.bonuses.map(bonus => ({
        slot: bonus.slot?.title || bonus.name || 'Unknown',
        bet: parseFloat(bonus.betSize) || 0,
        win: parseFloat(bonus.payout) || 0,
        multiplier: bonus.betSize ? ((bonus.payout || 0) / bonus.betSize).toFixed(2) : 0,
        provider: bonus.slot?.provider || '',
        date: new Date().toISOString()
      }));
      const valid = transformed.filter(t => t.bet > 0);
      if (valid.length > 0) allHunts.push({date: new Date().toISOString(), bonuses: valid});
    });
    
    cdewHunts = allHunts;
    res.json({ok: true, huntsImported: allHunts.length, totalBonuses: allHunts.reduce((sum, h) => sum + (h.bonuses?.length || 0), 0)});
  } catch (err) {
    console.error('Error fetching Cdew hunts:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/cdew-hunts', (req, res) => {
  res.json({hunts: cdewHunts, count: cdewHunts.length});
});

app.get('/api/autocomplete/users', (req, res) => {
  const allUsers = new Set();
  // Collect from all hunt equity members
  Object.values(hunts).forEach(hunt => {
    if (hunt.equity && Array.isArray(hunt.equity)) {
      hunt.equity.forEach(e => {
        if (e.name) allUsers.add(e.name);
      });
    }
  });
  // Add active users
  activeUsers.forEach(userData => {
    if (userData.user?.displayName) allUsers.add(userData.user.displayName);
    if (userData.user?.username) allUsers.add(userData.user.username);
  });
  res.json({ users: Array.from(allUsers).sort() });
});

app.get('/api/admin/active-users', requireAdmin, (req, res) => {
  const users = Array.from(activeUsers.values()).map(userData => ({
    username: userData.user?.displayName || userData.user?.username || 'Unknown',
    avatar: userData.user?.avatar || null,
    lastActive: userData.lastActive,
    currentPage: userData.currentPage,
    socketCount: userData.socketCount
  }));
  res.json({ users, count: users.length });
});

app.post('/api/admin/hunts/:userId/end', requireAdmin, (req, res) => {
  const h = hunts[req.params.userId];
  if (!h) return res.status(404).json({error:'Not found'});
  h.isLive = false; h.archivedAt = new Date().toISOString();
  emitHubUpdate(); io.to(`hunt:${req.params.userId}`).emit('hunt:update', h);
  res.json({ok:true});
});

app.delete('/api/admin/hunts/:userId', requireAdmin, (req, res) => {
  if (!hunts[req.params.userId]) return res.status(404).json({error:'Not found'});
  delete hunts[req.params.userId]; emitHubUpdate();
  res.json({ok:true});
});

// ── Ticket system ──────────────────────────────────────────────────
// Randy Cabbage's Discord ID
const RANDY_DISCORD_ID = process.env.RANDY_DISCORD_ID || '135203806676779008';

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
      const parts = content.split(/[,\n]/).map(p => p.trim()).filter(p => p.length > 2 && p.length < 80);

      for (const part of parts) {
        const slotName = part.replace(/^[#\-•*\d.]+\s*/, '').trim();
        // Only import if: slot is at least 5 chars OR contains multiple words OR contains slot keywords
        const hasMultipleWords = /\s/.test(slotName);
        const hasSlotKeyword = /bonus|bonanza|gold|megaways|wild|dead|princess|leopard|leopards|fire|beach|xmas|100x|1000|gates|gates|sweet|starlight|fruit|dog|house|bass|big|fishin|power|great|rhino|buffalo|king|lion|lions|eye|aztec|floating|dragon|book|legacy|rise|doom|wanted|deadwood|rich|amulet|hold|spinner|halloween|christmas|crash|crash|xmas|100|splash|xtreme|bash|races/i.test(slotName);
        
        if (slotName && (slotName.length >= 5 || hasMultipleWords || hasSlotKeyword) && !existingSlots.has(slotName.toLowerCase())) {
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
      const match = line.match(/^#(\d+)\s+(.+?)\s+(\d+\.\d+)/);
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
let slotCache = { games: [], fetchedAt: 0 };

async function getSlotGames() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (slotCache.games.length && Date.now() - slotCache.fetchedAt < ONE_HOUR) {
    return slotCache.games;
  }
  try {
    const res = await fetch('https://slot.report/api/v1/slots.json');
    const data = await res.json();
    slotCache.games = (data.results || []).filter(s => s.name);
    slotCache.fetchedAt = Date.now();
    console.log(`[slots] Cached ${slotCache.games.length} slots`);
  } catch(e) {
    console.error('[slots] Failed to fetch slot list:', e.message);
  }
  return slotCache.games;
}

// Pre-fetch on startup
getSlotGames().catch(() => {});

app.get('/api/slots/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q || q.length < 2) return res.json([]);
  const names = await getSlotNames();
  const games = await getSlotGames();
  const results = games
    .filter(g => g.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q);
      const bStarts = b.name.toLowerCase().startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 20)
    .map(g => ({
      name: g.name,
      slug: g.slug,
      provider: g.provider_slug || g.provider?.toLowerCase().replace(/[^a-z0-9]/g,'') || '',
      thumb: `https://usercontent.cc/images/games/${g.provider_slug || ''}/${g.slug}.webp`
    }));
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
const activeUsers = new Map(); // userId → { user, lastActive, currentPage, socketCount }

io.on('connection', socket => {
  socketUsers[socket.id] = {};
  
  socket.on('watch:hub', () => {
    socket.join('hub');
    socket.emit('hub:update', getPublicHunts());
    socket.emit('bean:live', beanLive);
  });

  socket.on('watch:hunt', userId => {
    socket.join(`hunt:${userId}`);
    socketUsers[socket.id].watchingHuntId = userId;
    socketUsers[socket.id].currentPage = 'hunt';
    viewers[userId] = (viewers[userId]||0) + 1;
    const h = hunts[userId];
    if (h) socket.emit('hunt:update', h);
    emitHubUpdate();
  });

  // Client sends their user id so we can compute canEdit for them
  socket.on('identify', (userId, user) => {
    socketUsers[socket.id].userId = userId;
    socketUsers[socket.id].user = user;
    
    // Track active user
    const userData = activeUsers.get(userId) || { user, socketCount: 0 };
    userData.lastActive = new Date();
    userData.socketCount = (userData.socketCount || 0) + 1;
    userData.currentPage = socketUsers[socket.id].currentPage || 'hub';
    activeUsers.set(userId, userData);
  });

  // Register disconnect handler ONCE per socket connection
  socket.on('disconnect', () => {
    const watchingUserId = socketUsers[socket.id]?.watchingHuntId;
    const userId = socketUsers[socket.id]?.userId;
    
    if (watchingUserId) {
      viewers[watchingUserId] = Math.max(0, (viewers[watchingUserId]||1) - 1);
      emitHubUpdate();
    }
    
    if (userId && activeUsers.has(userId)) {
      const existing = activeUsers.get(userId);
      existing.socketCount = Math.max(0, (existing.socketCount || 1) - 1);
      if (existing.socketCount === 0) {
        activeUsers.delete(userId);
      }
    }
    
    delete socketUsers[socket.id];
  });

  // On reinvite, socket re-fetches permissions from the API
  // (handled client-side in WatchHunt)
});

server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
