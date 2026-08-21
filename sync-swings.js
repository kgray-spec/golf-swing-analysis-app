#!/usr/bin/env node
/* ============================================================
   sync-swings.js
   Pulls new swing submissions out of the ClickUp "🏌️ Swing Analysis"
   list, downloads the student's videos, and drops them into the
   app's Library/ folder with tidy names the app can parse.

   Optionally mirrors each file to SWING_MIRROR_DIR (point that at a
   Google Drive sync folder to get the Drive copy).

   Run once:     node sync-swings.js
   Keep running: node sync-swings.js --watch          (default 5 min)
                 node sync-swings.js --watch=120      (seconds)
   Dry run:      node sync-swings.js --dry

   Needs a ClickUp personal API token. Create one at
   ClickUp → your avatar → Settings → Apps → API Token, then put it in
   a file called `.env` next to this script:

       CLICKUP_TOKEN=pk_xxxxxxxxxxxxxxxx

   No dependencies.
   ============================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT       = __dirname;
const LIBRARY    = process.env.SWING_LIBRARY || path.join(ROOT, 'Library');
const MIRROR     = process.env.SWING_MIRROR_DIR || '';        // e.g. a Google Drive folder
const STATE_FILE = path.join(ROOT, '.sync-state.json');

/* The ClickUp list that swing submissions land in. */
const LIST_ID = process.env.CLICKUP_LIST_ID || '900801277719';   // 🏌️ Swing Analysis

const VIDEO_MIME = /^video\//;
const VIDEO_EXT  = /\.(mp4|mov|m4v|webm|avi)$/i;

/* ---------- config ---------------------------------------------------- */
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();

const TOKEN = process.env.CLICKUP_TOKEN;
const args  = process.argv.slice(2);
const DRY   = args.includes('--dry');
const watchArg = args.find(a => a.startsWith('--watch'));
const WATCH = watchArg ? (parseInt(watchArg.split('=')[1], 10) || 300) : 0;

if (!TOKEN && require.main === module) {
  console.error(`
  Missing CLICKUP_TOKEN.

  1. ClickUp → avatar (bottom left) → Settings → Apps → API Token → Generate
  2. Create a file called .env next to this script containing:

       CLICKUP_TOKEN=pk_your_token_here
`);
  process.exit(1);
}

/* ---------- state ----------------------------------------------------- */
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { done: [], lastRun: null }; }
}
function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/* ---------- naming ---------------------------------------------------- */
const slug = s => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')
  .replace(/-{2,}/g, '-').slice(0, 48) || 'clip';

/* Turn a ClickUp attachment-field name into a short camera angle. */
function angleFrom(fieldName) {
  const n = String(fieldName || '').toLowerCase();
  if (/face[\s-]*on/.test(n))                     return 'face-on';
  if (/down[\s-]*the[\s-]*line|\bdtl\b/.test(n))  return 'down-the-line';
  if (/launch monitor|statistic|data/.test(n))    return 'launch-monitor';
  if (/slow|short game|putt|chip|bunker/.test(n)) return slug(n.replace(/upload( a| any)?/i, ''));
  if (!n) return 'clip';
  return slug(n.replace(/^upload( a| any)?\s*/i, '').replace(/:$/, '')) || 'clip';
}

/* ---------- ClickUp --------------------------------------------------- */
async function clickup(url) {
  const r = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!r.ok) throw new Error(`ClickUp ${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

/* Every video attachment on a task, tagged with the field it came from. */
function videosOn(task) {
  const out = [];
  const seen = new Set();

  for (const f of task.custom_fields || []) {
    if (f.type !== 'attachment' || !Array.isArray(f.value)) continue;
    for (const a of f.value) {
      if (!a || a.deleted) continue;
      if (!(VIDEO_MIME.test(a.mimetype || '') || VIDEO_EXT.test(a.title || ''))) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ ...a, angle: angleFrom(f.name) });
    }
  }

  /* files dragged straight onto the task rather than into a form field */
  for (const a of task.attachments || []) {
    if (!a || a.deleted || seen.has(a.id)) continue;
    if (!(VIDEO_MIME.test(a.mimetype || '') || VIDEO_EXT.test(a.title || ''))) continue;
    seen.add(a.id);
    out.push({ ...a, angle: 'clip' });
  }

  return out;
}

async function fetchTasks(sinceMs) {
  const tasks = [];
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({
      page: String(page),
      include_closed: 'true',
      subtasks: 'true',
      order_by: 'created',
      reverse: 'true',
    });
    if (sinceMs) qs.set('date_updated_gt', String(sinceMs));
    const data = await clickup(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?${qs}`);
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (batch.length < 100) break;
  }
  return tasks;
}

/* ---------- download -------------------------------------------------- */
async function download(att, destPath) {
  const url = att.url_w_host || att.url;
  let r = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!r.ok) r = await fetch(url);                    // CDN URLs are usually open
  if (!r.ok) throw new Error(`download ${r.status} — ${att.title}`);

  const tmp = destPath + '.part';
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, destPath);
  return buf.length;
}

/* ---------- one pass -------------------------------------------------- */
async function sync() {
  const state = readState();
  const done  = new Set(state.done);

  fs.mkdirSync(LIBRARY, { recursive: true });
  if (MIRROR) { try { fs.mkdirSync(MIRROR, { recursive: true }); } catch {} }

  const since = state.lastRun ? state.lastRun - 60_000 : null;   // 1 min overlap
  const tasks = await fetchTasks(since);

  let added = 0, skipped = 0, failed = 0;

  for (const task of tasks) {
    const vids = videosOn(task);
    if (!vids.length) continue;

    const created = new Date(Number(task.date_created || Date.now()));
    const date    = created.toISOString().slice(0, 10);
    const student = slug(task.name);

    for (const v of vids) {
      if (done.has(v.id)) { skipped++; continue; }

      const ext  = (path.extname(v.title || '') || '.mp4').toLowerCase();
      const name = `${date}__${student}__${v.angle}__${task.id}${ext}`;
      const dest = path.join(LIBRARY, name);

      if (fs.existsSync(dest)) { done.add(v.id); skipped++; continue; }

      if (DRY) { console.log(`  would fetch  ${name}`); added++; continue; }

      try {
        const size = await download(v, dest);
        done.add(v.id);
        added++;
        console.log(`  + ${name}  (${(size / 1e6).toFixed(1)} MB)`);

        if (MIRROR) {
          try { fs.copyFileSync(dest, path.join(MIRROR, name)); }
          catch (e) { console.warn(`    mirror failed: ${e.message}`); }
        }
      } catch (e) {
        failed++;
        console.warn(`  ! ${name}: ${e.message}`);
      }
    }
  }

  if (!DRY) {
    state.done = [...done].slice(-5000);     // keep the ledger from growing forever
    state.lastRun = Date.now();
    writeState(state);
  }

  const stamp = new Date().toLocaleTimeString();
  console.log(`[${stamp}] ${tasks.length} task(s) checked · ${added} new · ${skipped} already had · ${failed} failed`);
  return added;
}

/* ---------- run ------------------------------------------------------- */
/* exported so the naming/extraction logic can be tested without ClickUp */
module.exports = { videosOn, angleFrom, slug, sync };
if (require.main !== module) return;

(async () => {
  console.log(`Swing sync → ${LIBRARY}${MIRROR ? `\n     mirror → ${MIRROR}` : ''}`);

  /* A failed sync must exit non-zero, otherwise the caller reports a
     bad token as "up to date" and you silently stop getting swings. */
  try {
    await sync();
  } catch (e) {
    const hint = /401|403/.test(e.message) ? ' — check CLICKUP_TOKEN in .env' : '';
    console.error(`  sync failed: ${e.message}${hint}`);
    if (!WATCH) process.exit(1);
  }

  if (WATCH) {
    console.log(`Watching — every ${WATCH}s. Ctrl-C to stop.`);
    setInterval(() => sync().catch(e => console.error(`  sync failed: ${e.message}`)), WATCH * 1000);
  }
})();
