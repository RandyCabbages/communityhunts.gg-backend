// Multi-tenancy: per-tenant config (concierge-authored) + roles, in Postgres.
// Cached in memory; resolved per request via the X-Tenant-Slug header (see server.js).
// When MULTI_TENANT is off or no slug is sent, callers use BEAN_TENANT (single-tenant behavior).

// Bean is the canonical platform owner (used for Bean's tenant identity: host id,
// crown). Keep this a scalar — branding/crown logic depends on a single Bean id.
const PLATFORM_OWNER_ID = '135203806676779008';

// Platform OWNERS (plural) — co-owners who show the "Owner" badge and can never be
// removed via the admin UI. Always includes Bean; extra owners come from the
// PLATFORM_OWNER_IDS env var (comma-separated Discord IDs). ID-only, never display name.
const PLATFORM_OWNER_IDS = [...new Set([
  PLATFORM_OWNER_ID,
  ...(process.env.PLATFORM_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
])];
function isPlatformOwnerId(id) { return !!id && PLATFORM_OWNER_IDS.includes(String(id)); }

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
  adminIds: [...new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean))],
  vipIds:   [...new Set((process.env.VIP_IDS   || '').split(',').map(s => s.trim()).filter(Boolean))],
  modIds:   [],
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
    // Widen the role CHECK to allow 'community_mod' (per-community Mod role). CREATE TABLE
    // IF NOT EXISTS above is a no-op against the already-existing production table, so the
    // new value must be added via explicit ALTER. Safe on every boot: DROP CONSTRAINT IF
    // EXISTS never errors, and re-adding a strictly wider constraint doesn't affect existing
    // 'admin'/'vip' rows. Postgres's default name for an unnamed table CHECK is
    // `{table}_{column}_check`, matching what CREATE TABLE implicitly created above.
    await pgPool.query(`ALTER TABLE tenant_roles DROP CONSTRAINT IF EXISTS tenant_roles_role_check`);
    await pgPool.query(`ALTER TABLE tenant_roles ADD CONSTRAINT tenant_roles_role_check CHECK (role IN ('admin','vip','community_mod'))`);
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
    // Seed Bean's initial Mod roster. Hardcoded (not env-driven) — no Railway env var or
    // manual script needed, this just works on the next deploy. Idempotent via ON CONFLICT
    // on the (tenant_id, discord_id, role) primary key. Bean himself needs no row — he's
    // PLATFORM_OWNER_ID, already admin everywhere.
    const BEAN_MOD_SEED = [
      '102963341407838208', // Mcflury
      '158594379773247489', // Missingiscool
      '197365493516992512', // mihailimou (nickname "Mih" — this spelling is canonical)
      '91723222743015424',  // Cuda
    ];
    for (const id of BEAN_MOD_SEED) await pgPool.query(`INSERT INTO tenant_roles VALUES('bean',$1,'community_mod') ON CONFLICT DO NOTHING`, [id]);
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
      modIds:   roleRows.filter(x => x.tenant_id === r.id && x.role === 'community_mod').map(x => x.discord_id),
    });
  }
  if (!cache.has('bean')) cache.set('bean', BEAN_TENANT);
}

function getTenantBySlug(slug) { return cache.get(slug) || null; }
function getAllTenants() { return [...cache.values()]; }
function isPlatformOwner(user) { return isPlatformOwnerId(user?.id); }
function isTenantAdmin(user, tenant) {
  if (!user?.id || !tenant) return false;
  if (isPlatformOwner(user)) return true;
  return (tenant.adminIds || []).includes(user.id);
}
function isTenantVip(user, tenant) {
  if (!user?.id || !tenant) return false;
  return isTenantAdmin(user, tenant) || (tenant.vipIds || []).includes(user.id);
}
// Per-community Mod role. Tenant admins (incl. platform owner) are always at least as
// powerful as a mod; otherwise must be in this tenant's modIds.
function isTenantMod(user, tenant) {
  if (!user?.id || !tenant) return false;
  if (isTenantAdmin(user, tenant)) return true;
  return (tenant.modIds || []).includes(user.id);
}

// ── Tenant-mod CRUD (DB-backed via tenant_roles role='community_mod') ──────
// Mirrors lib/admins.js's listDbAdmins/addDbAdmin/removeDbAdmin pattern, but tenant-scoped.
async function listTenantMods(tenantId) {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query(
      `SELECT discord_id FROM tenant_roles WHERE tenant_id=$1 AND role='community_mod'`,
      [tenantId]);
    return r.rows.map(row => String(row.discord_id));
  } catch (e) { console.error('[tenants] listTenantMods failed:', e.message); return []; }
}
async function addTenantMod(tenantId, discordId) {
  if (!pgPool || !tenantId || !discordId) return;
  try {
    await pgPool.query(
      `INSERT INTO tenant_roles (tenant_id, discord_id, role) VALUES ($1,$2,'community_mod')
       ON CONFLICT DO NOTHING`,
      [tenantId, String(discordId)]);
    await reloadCache();
  } catch (e) { console.error('[tenants] addTenantMod failed:', e.message); throw e; }
}
async function removeTenantMod(tenantId, discordId) {
  if (!pgPool || !tenantId || !discordId) return;
  try {
    await pgPool.query(
      `DELETE FROM tenant_roles WHERE tenant_id=$1 AND discord_id=$2 AND role='community_mod'`,
      [tenantId, String(discordId)]);
    await reloadCache();
  } catch (e) { console.error('[tenants] removeTenantMod failed:', e.message); throw e; }
}

module.exports = { PLATFORM_OWNER_ID, PLATFORM_OWNER_IDS, isPlatformOwnerId,
  BEAN_TENANT, initTenants, reloadCache,
  getTenantBySlug, getAllTenants, isPlatformOwner, isTenantAdmin, isTenantVip, isTenantMod,
  listTenantMods, addTenantMod, removeTenantMod };
