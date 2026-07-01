// Runs the Rainbet new-slots check (scripts/check_new_slots.js) on a timer inside
// the live backend process, instead of relying on GitHub Actions' `schedule` trigger
// (which was observed firing every 1.5-5 hours instead of the configured 30 minutes —
// GitHub silently throttles/drops frequent cron schedules under load).
//
// On a change it writes rainbet_slots.json, hot-reloads it into lib/slots.js's
// in-memory search pool (no redeploy needed), then commits the file via GitHub's
// Contents API so the change survives the next deploy — same durability the GitHub
// Actions bot had. Uses the API (not local git commands) because Railway's Railpack
// build doesn't include a .git directory in the runtime image.
//
// Requires GITHUB_PAT (repo contents:write) to persist; without it, slots still get
// found and searchable immediately, but won't survive a redeploy. See CLAUDE.md.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');
const INTERVAL_MS = 10 * 60 * 1000;

const GITHUB_PAT = process.env.GITHUB_PAT || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'RandyCabbages/communityhunts-backend';
const CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents/rainbet_slots.json`;

let warnedNoPat = false;

async function githubApi(method, body) {
  const res = await fetch(CONTENTS_URL, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'communityhunts-backend',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API ${method} ${res.status}: ${data.message || res.statusText}`);
  return data;
}

async function commitViaApi() {
  if (!GITHUB_PAT) {
    if (!warnedNoPat) {
      console.warn('[rainbet-sync] GITHUB_PAT not set — new slots will NOT survive a redeploy until this is fixed');
      warnedNoPat = true;
    }
    return;
  }

  try {
    const content = fs.readFileSync(SLOTS_FILE, 'utf8');
    const current = await githubApi('GET');
    const currentContent = Buffer.from(current.content, 'base64').toString('utf8');
    if (currentContent === content) return; // main already matches (e.g. pushed by another process)

    await githubApi('PUT', {
      message: `auto: rainbet new releases (${new Date().toISOString().slice(0, 10)})`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: current.sha,
      branch: 'main',
      committer: { name: 'rainbet-slots-bot', email: 'actions@users.noreply.github.com' },
    });
    console.log('[rainbet-sync] committed rainbet_slots.json update to main via GitHub API');
  } catch (e) {
    console.error('[rainbet-sync] GitHub API commit failed (slots are still live in memory, just not persisted):', e.message);
  }
}

async function runOnce(slots) {
  let result;
  try {
    result = await require('../scripts/check_new_slots').runCheck();
  } catch (e) {
    console.error('[rainbet-sync] check failed:', e.message);
    return;
  }

  if (!result.changed) return;

  console.log(`[rainbet-sync] +${result.added} / -${result.removed} slots — reloading + persisting`);
  slots.reloadRainbetSlots();
  await commitViaApi();
}

function startRainbetSlotSync(slots) {
  runOnce(slots).catch(e => console.error('[rainbet-sync] initial run failed:', e.message));
  setInterval(() => runOnce(slots).catch(e => console.error('[rainbet-sync] run failed:', e.message)), INTERVAL_MS);
}

module.exports = { startRainbetSlotSync };
