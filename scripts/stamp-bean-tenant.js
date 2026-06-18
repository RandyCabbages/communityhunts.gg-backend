// scripts/stamp-bean-tenant.js — one-shot, idempotent.
// Stamps tenantId:'bean' onto every existing hunt + archive record in hunts_kv.
// Belt-and-suspenders: the app already treats untagged hunts as Bean (tenantOf()),
// so it works without this; the script just makes the data explicit.
// Run once after deploy:  DATABASE_URL=... node scripts/stamp-bean-tenant.js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const huntsRow   = await pool.query("SELECT value FROM hunts_kv WHERE key='hunts'");
  const archiveRow = await pool.query("SELECT value FROM hunts_kv WHERE key='archive'");
  const hunts   = huntsRow.rows[0]?.value || {};
  const archive = archiveRow.rows[0]?.value || [];

  let n = 0;
  for (const id in hunts) if (!hunts[id].tenantId) { hunts[id].tenantId = 'bean'; n++; }
  let m = 0;
  for (const h of archive) if (!h.tenantId) { h.tenantId = 'bean'; m++; }

  await pool.query("INSERT INTO hunts_kv(key,value) VALUES('hunts',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify(hunts)]);
  await pool.query("INSERT INTO hunts_kv(key,value) VALUES('archive',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify(archive)]);
  console.log(`stamped ${n} hunts, ${m} archived as tenant 'bean'`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
