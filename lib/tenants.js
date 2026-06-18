// Multi-tenancy: per-tenant config (concierge-authored) + roles, in Postgres.
// Cached in memory; resolved per request via the X-Tenant-Slug header (see server.js).
// When MULTI_TENANT is off or no slug is sent, callers use BEAN_TENANT (single-tenant behavior).

const PLATFORM_OWNER_ID = '135203806676779008';

// Default/fallback tenant — mirrors today's single-tenant Bean behavior.
const BEAN_TENANT = {
  id: 'bean', slug: 'bean', displayName: 'Bean',
  twitchChannel: 'bean',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordCallsChannelId: process.env.DISCORD_CALLS_CHANNEL_ID || '',
  discordWinnersChannelId: process.env.DISCORD_WINNERS_CHANNEL_ID || '',
  leaderboardUrl: 'https://api.beantwitch.com',
  hostDiscordId: PLATFORM_OWNER_ID,
  branding: { hostName: 'Bean', crownDiscordId: PLATFORM_OWNER_ID, accent: '#a78bfa' },
  isActive: true,
  adminIds: (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  vipIds:   (process.env.VIP_IDS   || '').split(',').map(s => s.trim()).filter(Boolean),
};

let pgPool = null;
const cache = new Map(); // slug -> tenant

async function initTenants(deps) {
  pgPool = deps.pgPool;
  cache.set('bean', BEAN_TENANT); // always available, even with no DB
  if (!pgPool) { console.log('[tenants] no DB — using in-memory Bean only'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id            TEXT PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        twitch_channel TEXT,
        discord_bot_token TEXT,
        discord_calls_channel_id TEXT,
        discord_winners_channel_id TEXT,
        leaderboard_url TEXT,
        host_discord_id TEXT,
        branding      JSONB NOT NULL DEFAULT '{}',
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tenant_roles (
        tenant_id  TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('admin','vip')),
        PRIMARY KEY (tenant_id, discord_id, role)
      )`);
    // Seed Bean row if absent (from current env vars)
    await pgPool.query(
      `INSERT INTO tenants(id,slug,display_name,twitch_channel,discord_bot_token,
         discord_calls_channel_id,discord_winners_channel_id,leaderboard_url,host_discord_id,branding)
       VALUES('bean','bean','Bean',$1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(id) DO NOTHING`,
      [BEAN_TENANT.twitchChannel, BEAN_TENANT.discordBotToken, BEAN_TENANT.discordCallsChannelId,
       BEAN_TENANT.discordWinnersChannelId, BEAN_TENANT.leaderboardUrl, BEAN_TENANT.hostDiscordId,
       JSON.stringify(BEAN_TENANT.branding)]);
    // Seed Bean roles from current env (ADMIN_IDS/VIP_IDS) so nobody loses access
    for (const id of BEAN_TENANT.adminIds) await pgPool.query(`INSERT INTO tenant_roles VALUES('bean',$1,'admin') ON CONFLICT DO NOTHING`, [id]);
    for (const id of BEAN_TENANT.vipIds)   await pgPool.query(`INSERT INTO tenant_roles VALUES('bean',$1,'vip')   ON CONFLICT DO NOTHING`, [id]);
    await reloadCache();
    console.log(`[tenants] loaded ${cache.size} tenant(s)`);
  } catch(e) {
    console.error('[tenants] init failed (falling back to in-memory Bean):', e.message);
  }
}

async function reloadCache() {
  if (!pgPool) return;
  const { rows } = await pgPool.query('SELECT * FROM tenants WHERE is_active=true');
  const roleRows = (await pgPool.query('SELECT * FROM tenant_roles')).rows;
  cache.clear();
  for (const r of rows) {
    cache.set(r.slug, {
      id: r.id, slug: r.slug, displayName: r.display_name,
      twitchChannel: r.twitch_channel, discordBotToken: r.discord_bot_token,
      discordCallsChannelId: r.discord_calls_channel_id,
      discordWinnersChannelId: r.discord_winners_channel_id,
      leaderboardUrl: r.leaderboard_url, hostDiscordId: r.host_discord_id,
      branding: r.branding || {}, isActive: r.is_active,
      adminIds: roleRows.filter(x => x.tenant_id === r.id && x.role === 'admin').map(x => x.discord_id),
      vipIds:   roleRows.filter(x => x.tenant_id === r.id && x.role === 'vip').map(x => x.discord_id),
    });
  }
  if (!cache.has('bean')) cache.set('bean', BEAN_TENANT);
}

function getTenantBySlug(slug) { return cache.get(slug) || null; }
function getAllTenants() { return [...cache.values()]; }
function isPlatformOwner(user) { return !!(user && user.id === PLATFORM_OWNER_ID); }
function isTenantAdmin(user, tenant) {
  if (!user?.id || !tenant) return false;
  if (isPlatformOwner(user)) return true;
  return (tenant.adminIds || []).includes(user.id);
}
function isTenantVip(user, tenant) {
  if (!user?.id || !tenant) return false;
  return isTenantAdmin(user, tenant) || (tenant.vipIds || []).includes(user.id);
}

module.exports = { PLATFORM_OWNER_ID, BEAN_TENANT, initTenants, reloadCache,
  getTenantBySlug, getAllTenants, isPlatformOwner, isTenantAdmin, isTenantVip };
