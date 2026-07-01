// Runs the Rainbet new-slots check (scripts/check_new_slots.js) on a timer inside
// the live backend process, instead of relying on GitHub Actions' `schedule` trigger
// (which was observed firing every 1.5-5 hours instead of the configured 30 minutes —
// GitHub silently throttles/drops frequent cron schedules under load).
//
// On a change it writes rainbet_slots.json, hot-reloads it into lib/slots.js's
// in-memory search pool (no redeploy needed), then commits + pushes the file so the
// change survives the next deploy — same durability the GitHub Actions bot had.
//
// Requires GITHUB_PAT (repo contents:write) to push; without it, slots still get
// found and searchable immediately, but won't survive a redeploy. See CLAUDE.md.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GIT_DIR = path.join(ROOT, '.git');
const SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');
const INTERVAL_MS = 10 * 60 * 1000;

const GITHUB_PAT = process.env.GITHUB_PAT || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'RandyCabbages/communityhunts-backend';
const REMOTE_URL = `https://github.com/${GITHUB_REPO}.git`;

let warnedNoGit = false;
let warnedNoPat = false;

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

// Auth via a per-invocation header, never written to any file on disk.
function authedGit(args) {
  const basic = Buffer.from(`x-access-token:${GITHUB_PAT}`).toString('base64');
  return git(['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`, ...args]);
}

async function commitAndPush() {
  if (!fs.existsSync(GIT_DIR)) {
    if (!warnedNoGit) {
      console.warn('[rainbet-sync] no .git directory in this deploy — new slots will NOT survive a redeploy until this is fixed');
      warnedNoGit = true;
    }
    return;
  }
  if (!GITHUB_PAT) {
    if (!warnedNoPat) {
      console.warn('[rainbet-sync] GITHUB_PAT not set — new slots will NOT survive a redeploy until this is fixed');
      warnedNoPat = true;
    }
    return;
  }

  try {
    const status = await git(['status', '--porcelain', 'rainbet_slots.json']);
    if (!status) return; // nothing to commit

    await git(['config', 'user.name', 'rainbet-slots-bot']);
    await git(['config', 'user.email', 'actions@users.noreply.github.com']);
    await git(['add', 'rainbet_slots.json']);
    await git(['commit', '-m', `auto: rainbet new releases (${new Date().toISOString().slice(0, 10)})`]);

    try {
      await authedGit(['push', REMOTE_URL, 'HEAD:main']);
    } catch (pushErr) {
      // Likely non-fast-forward — our checkout is behind main. Rebase our one-file
      // commit on top of latest main and retry once.
      console.warn('[rainbet-sync] push rejected, rebasing onto latest main:', pushErr.message);
      await authedGit(['fetch', REMOTE_URL, 'main']);
      await git(['rebase', 'FETCH_HEAD']);
      await authedGit(['push', REMOTE_URL, 'HEAD:main']);
    }
    console.log('[rainbet-sync] pushed rainbet_slots.json update to main');
  } catch (e) {
    console.error('[rainbet-sync] git commit/push failed (slots are still live in memory, just not persisted):', e.message);
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
  await commitAndPush();
}

function startRainbetSlotSync(slots) {
  runOnce(slots).catch(e => console.error('[rainbet-sync] initial run failed:', e.message));
  setInterval(() => runOnce(slots).catch(e => console.error('[rainbet-sync] run failed:', e.message)), INTERVAL_MS);
}

module.exports = { startRainbetSlotSync };
