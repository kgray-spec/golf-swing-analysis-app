/* Dependency-free static server + swing library API.
   `node server.js` then open the printed URL. */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');

const ROOT    = __dirname;
const LIBRARY = process.env.SWING_LIBRARY || path.join(ROOT, 'Library');
const PORT    = process.env.PORT || 5178;

const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
  '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon',
  '.mp4':'video/mp4', '.mov':'video/quicktime', '.m4v':'video/x-m4v', '.webm':'video/webm' };

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);

/* ---------- library listing ----------------------------------------- */
/* Filenames written by sync-swings.js look like:
     2026-08-20__Brent-Burton__face-on__86cuc24ne.mov
   We parse that back out for display, but any video file works. */
function parseName(file) {
  const base = file.replace(/\.[^.]+$/, '');
  const bits = base.split('__');
  if (bits.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(bits[0])) {
    return {
      date:    bits[0],
      student: bits[1].replace(/-/g, ' '),
      angle:   bits[2].replace(/-/g, ' '),
    };
  }
  return { date: null, student: base, angle: null };
}

function listLibrary() {
  let names;
  try { names = fs.readdirSync(LIBRARY); }
  catch { return []; }

  return names
    .filter(n => !n.startsWith('.') && VIDEO_EXT.has(path.extname(n).toLowerCase()))
    .map(n => {
      let st; try { st = fs.statSync(path.join(LIBRARY, n)); } catch { return null; }
      return { file: n, size: st.size, mtime: st.mtimeMs, ...parseName(n) };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/* ---------- byte-range file serving (video scrubbing needs this) ----- */
function serveFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);

  const type  = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] === '' ? null : parseInt(m[1], 10);
      let end   = m[2] === '' ? null : parseInt(m[2], 10);
      if (start === null) { start = st.size - end; end = st.size - 1; }   // suffix range
      if (end === null || end >= st.size) end = st.size - 1;

      if (isNaN(start) || start > end || start < 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const notFound = res => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); };
const json = (res, data) => {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
  res.end(body);
};

/* ---------- ClickUp sync ---------------------------------------------
   launchd can't reach ~/Documents without Full Disk Access, so the daily
   pull lives here instead: the app syncs itself when you open it, then
   once a day while it stays running. No permissions, no extra processes. */
const SYNC_SCRIPT = path.join(ROOT, 'sync-swings.js');
const DAY_MS = 24 * 60 * 60 * 1000;

const sync = { running: false, lastRun: null, lastResult: null, added: 0 };

const syncConfigured = () => {
  if (process.env.CLICKUP_TOKEN) return true;
  try { return /^\s*CLICKUP_TOKEN\s*=\s*\S/m.test(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); }
  catch { return false; }
};

/* Last line of the child's output, minus the noisy URL, short enough for the sheet. */
function tidyError(out) {
  const line = out.trim().split('\n').filter(Boolean).pop() || '';
  return line
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*sync failed:\s*/i, '')
    .replace(/\s*—(\s*—)+\s*/g, ' — ')     // the stripped URL leaves a dangling dash pair
    .replace(/\s*—\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 110);
}

function runSync(reason) {
  if (sync.running) return;
  if (!syncConfigured()) { sync.lastResult = 'no ClickUp token yet — see README'; return; }
  if (!fs.existsSync(SYNC_SCRIPT)) { sync.lastResult = 'sync-swings.js missing'; return; }

  sync.running = true;
  console.log(`  syncing swings from ClickUp (${reason})…`);

  const before = listLibrary().length;
  const child = spawn(process.execPath, [SYNC_SCRIPT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let tail = '';
  const grab = d => { tail = (tail + d.toString()).slice(-600); process.stdout.write('  ' + d.toString()); };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);

  child.on('close', code => {
    sync.running = false;
    sync.lastRun = Date.now();
    sync.added = Math.max(0, listLibrary().length - before);
    sync.lastResult = code === 0
      ? (sync.added ? `${sync.added} new clip${sync.added === 1 ? '' : 's'}` : 'up to date')
      : tidyError(tail) || `exited ${code}`;
    console.log(`  sync finished: ${sync.lastResult}`);
  });

  child.on('error', e => {
    sync.running = false; sync.lastResult = e.message;
  });
}

/* ---------- router --------------------------------------------------- */
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/api/library') {
    return json(res, {
      dir: LIBRARY,
      items: listLibrary(),
      sync: { ...sync, configured: syncConfigured() },
    });
  }

  if (url === '/api/sync') { runSync('manual'); return json(res, { started: true }); }

  if (url.startsWith('/library/')) {
    const name = path.basename(url.slice('/library/'.length));   // strip any traversal
    return serveFile(req, res, path.join(LIBRARY, name));
  }

  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  serveFile(req, res, file);

}).listen(PORT, () => {
  try { fs.mkdirSync(LIBRARY, { recursive: true }); } catch {}
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`\n  Swing running:\n    http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`    http://${ip}:${PORT}   ← open this on your phone/iPad`));
  console.log(`  Swing library: ${LIBRARY}  (${listLibrary().length} clips)`);
  console.log(syncConfigured()
    ? '  ClickUp sync: on (runs now, then daily)\n'
    : '  ClickUp sync: off — add CLICKUP_TOKEN to .env (see README)\n');

  runSync('startup');
  setInterval(() => runSync('daily'), DAY_MS);
});
