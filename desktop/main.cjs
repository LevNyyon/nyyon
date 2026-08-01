// Nyyon Command Center — the desktop shell.
//
// Double-click, get a window. No terminal, no localhost URL to remember, a real
// icon in the dock. Underneath it is exactly what `npm start` runs — the worker
// and Vite as child processes — because the point is a friendlier door onto the
// local install, not a different app. The repo stays on disk and stays
// editable: nothing is bundled or frozen, so Claude Code can still change the
// source and the window picks it up on reload.
//
// Deliberately Electron rather than Tauri: Tauri needs a Rust toolchain, and
// "install Rust first" is a worse opening move than a bigger download.
//
// FIRST LAUNCH IS THE HARD PART. A cold start installs dependencies, builds the
// SPA, creates a database and boots two servers — a minute or more of nothing.
// A blank window there reads as broken, so the splash reports real progress
// against real milestones. The percentages are honest weights (dependencies
// genuinely dominate), never a timer pretending to be work.

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, createWriteStream } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

app.setName('Nyyon Command Center');

// WHERE THE SOURCE LIVES.
//
// The shell deliberately does not bundle the app it runs — the repo stays on
// disk and stays editable, which is the whole point. So the packaged .app has
// to FIND that repo rather than contain it. Walking up from wherever this
// binary sits covers both shapes: `npm run app` (running from desktop/) and a
// packaged bundle in desktop/out/. NYYON_REPO overrides for a bundle that has
// been moved somewhere else entirely, e.g. /Applications.
function findRepo() {
  const marks = [process.env.NYYON_REPO, __dirname, process.execPath].filter(Boolean);
  for (const start of marks) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (existsSync(path.join(dir, 'workers', 'api', 'wrangler.jsonc'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return null;
}

const repo = findRepo();
const apiDir = repo && path.join(repo, 'workers', 'api');
const webDir = repo && path.join(repo, 'web');
// Bundled WhatsApp daemon (services/whatsapp). Started as a child like the
// worker and the interface, so Outreach works on a fresh install without the
// operator hosting anything. It is deliberately NOT started when its
// dependencies are absent — see startup.
const waDir  = repo && path.join(repo, 'services', 'whatsapp');
const ICON = path.join(__dirname, 'assets', 'icon.png');

const API_PORT = Number(process.env.NYYON_API_PORT || 8799);
const WEB_PORT = Number(process.env.NYYON_WEB_PORT || 5180);
const WA_PORT  = Number(process.env.NYYON_WA_PORT  || 2785);
const APP_URL = `http://localhost:${WEB_PORT}`;

let win = null;
const children = [];
let quitting = false;

// LOGGING WITHOUT A TERMINAL.
//
// Launched from Finder there is no stdout to write to, and writing anyway
// throws EPIPE from deep inside a stream callback — an uncaught exception
// dialog on top of a working app. So every child's output goes to a file, and
// stdout is only attempted when something is actually attached to it.
//
// The file is worth having regardless: when someone reports "it did not
// start", this is the only record of why.
const LOG_DIR = path.join(require('node:os').homedir(), 'Library', 'Logs', 'Nyyon Command Center');
let logStream = null;
try {
  mkdirSync(LOG_DIR, { recursive: true });
  logStream = createWriteStream(path.join(LOG_DIR, 'app.log'), { flags: 'a' });
  logStream.on('error', () => { logStream = null; });   // never let logging kill the app
} catch { /* no log file; the app still runs */ }

const hasStdout = Boolean(process.stdout && process.stdout.isTTY);
function log(line) {
  const text = String(line);
  try { logStream?.write(text); } catch { /* ignore */ }
  if (hasStdout) { try { process.stdout.write(text); } catch { /* ignore */ } }
}

// A stray EPIPE anywhere else must not surface as a crash dialog either.
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) { log(`[ignored] ${err.code}\n`); return; }
  log(`[fatal] ${err?.stack || err}\n`);
  dialog.showErrorBox('Nyyon Command Center hit an error', `${err?.message || err}\n\nDetails: ${path.join(LOG_DIR, 'app.log')}`);
});

// ── the splash ──────────────────────────────────────────────────────────────
// Inline because it has to render before anything else on disk is guaranteed
// to exist. Updated by executeJavaScript rather than IPC: one window, one
// direction, no preload bridge to maintain for a loading screen.
const SPLASH = `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;
  background:#FAFAF9;font:13px ui-sans-serif,system-ui,-apple-system;color:#0A0A0A">
  <div style="position:fixed;top:0;left:0;right:0;height:38px;-webkit-app-region:drag"></div>
  <div style="width:min(340px,80vw);text-align:center">
    <svg width="34" height="37" viewBox="0 0 64 70" style="margin-bottom:18px">
      <path d="M33,0 L64,0 L64,66 L33,50 L33,0 Z M0,4 L31,20 L31,70 L0,70 L0,4 Z" fill="#0A0A0A" fill-rule="evenodd"/>
    </svg>
    <div id="label" style="font-family:ui-monospace,SFMono-Regular,monospace;font-size:10px;
         letter-spacing:.18em;text-transform:uppercase;color:#78716C">starting</div>
    <div style="margin-top:14px;height:3px;background:#E7E5E4;border-radius:99px;overflow:hidden">
      <div id="bar" style="height:100%;width:0%;background:#10B981;border-radius:99px;
           transition:width .45s cubic-bezier(.4,0,.2,1)"></div>
    </div>
    <div id="pct" style="margin-top:8px;font-family:ui-monospace,monospace;font-size:10px;color:#A8A29E">0%</div>
    <div id="hint" style="margin-top:22px;font-size:11px;color:#A8A29E;line-height:1.5"></div>
  </div>
</body></html>`;

function progress(pct, label, hint = '') {
  if (!win || win.isDestroyed()) return;
  const esc = (s) => JSON.stringify(String(s));
  win.webContents.executeJavaScript(`
    (() => {
      const b=document.getElementById('bar'), l=document.getElementById('label'),
            p=document.getElementById('pct'), h=document.getElementById('hint');
      if (b) b.style.width = ${pct}+'%';
      if (l) l.textContent = ${esc(label)};
      if (p) p.textContent = ${pct}+'%';
      if (h) h.textContent = ${esc(hint)};
    })()`).catch(() => { /* window went away mid-update */ });
  // The dock icon carries the same progress, so it reads even when the window
  // is behind something else.
  try { win.setProgressBar(pct >= 100 ? -1 : pct / 100); } catch { /* not supported */ }
}

// ── helpers ─────────────────────────────────────────────────────────────────

// Is this port ours to take?
//
// Without this check a busy port is the worst kind of failure: wrangler and
// vite exit with "Address already in use" into a log nobody is reading, the
// progress bar sits at 40% forever, and the app looks hung. Worse, if the
// squatter happens to answer on the web port, readiness passes and we load
// SOMEBODY ELSE'S server into the window, which looks like the app working
// while pointing at the wrong database. Both are silent, so check first and
// say so plainly.
// Detect by CONNECTING, not by binding, and on both IP stacks.
//
// The obvious implementation — bind the port and see if it fails — quietly
// misses the most common squatter. Vite listens on ::1, so a bind test against
// 127.0.0.1 reports the port free while Vite is very much sitting on it. A
// connect attempt answers the question actually being asked: is anything
// already there?
function portBusy(port) {
  const probe = (host) => new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (busy) => { sock.destroy(); resolve(busy); };
    sock.setTimeout(700);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error',   () => done(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((r) => r.some(Boolean));
}

async function assertPortsFree() {
  const busy = [];
  for (const [port, what] of [[API_PORT, 'the engine'], [WEB_PORT, 'the interface']]) {
    if (await portBusy(port)) busy.push(`${port} (${what})`);
  }
  if (busy.length) {
    throw new Error(
      `Port ${busy.join(' and ')} is already in use.\n\n` +
      'Something else on this Mac is using it — most often another copy of ' +
      'this app, or a dev server left running in a terminal. Quit that and ' +
      'open Nyyon Command Center again.',
    );
  }
}

function waitForServer(url, timeoutMs = 120_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (quitting) return;
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > timeoutMs) reject(new Error(`timed out waiting for ${url}`));
          else setTimeout(tick, 400);
        });
    };
    tick();
  });
}

// SPAWNING THROUGH A LOGIN SHELL, on purpose.
//
// An app launched from Finder inherits a bare PATH — /usr/bin:/bin and little
// else. node, npm and npx live in Homebrew, nvm or Volta directories that are
// only on PATH because a shell rc file put them there, so a plain spawn works
// perfectly from a terminal and fails the moment somebody double-clicks the
// icon. That asymmetry is exactly the bug a packaged app hits first.
//
// A login shell reads those rc files, so the child gets the same PATH the
// operator has when they type the command themselves.
function spawnTool(name, cmd, args, cwd) {
  const quoted = [cmd, ...args].map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  if (process.platform === 'win32') {
    return spawn(cmd, args, { cwd, env: process.env, shell: true });
  }
  const shellPath = process.env.SHELL || '/bin/zsh';
  return spawn(shellPath, ['-lc', quoted], { cwd, env: process.env });
}

// Run a command, reporting progress across a band as its output arrives. npm
// and vite do not emit percentages, so the band advances on activity and is
// capped below its ceiling — it never claims a step finished early.
function runStep(cmd, args, cwd, { from, to, label, hint }) {
  return new Promise((resolve, reject) => {
    progress(from, label, hint);
    const child = spawnTool(cmd, cmd, args, cwd);
    let pct = from;
    const nudge = (buf) => {
      log(`[${label}] ${buf}`);
      pct = Math.min(pct + (to - from) / 22, to - 1);
      progress(Math.round(pct), label, hint);
    };
    child.stdout.on('data', nudge);
    child.stderr.on('data', nudge);
    child.on('exit', (code) => (code === 0 ? (progress(to, label, hint), resolve()) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

function startServer(name, args, cwd) {
  const child = spawnTool(name, 'npx', args, cwd);
  // Tag it so a running service can be identified later. Without this the
  // on-demand install cannot tell "already running" from "not started".
  child.__name = name;
  children.push(child);
  const tag = (buf) => log(`[${name}] ${buf}`);
  child.stdout.on('data', tag);
  child.stderr.on('data', tag);
  child.on('exit', (code) => {
    if (quitting) return;
    dialog.showErrorBox('Nyyon Command Center stopped',
      `The ${name} process exited (${code}).\n\nClose and reopen the app. If it keeps happening, run "npm run setup" in ${repo}.`);
  });
  return child;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'Nyyon Command Center',
    icon: existsSync(ICON) ? ICON : undefined,
    backgroundColor: '#FAFAF9',
    // Standard title bar, deliberately. 'hiddenInset' looks better but asks
    // the PAGE to declare its own drag regions, and the SPA declares none —
    // on macOS that left the frameless chrome eating mouse events, so a click
    // never focused a field while Tab (no hit-testing needed) still worked.
    titleBarStyle: 'default',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Narrow, named bridge so the page can ask for an on-demand service
      // install (see preload.cjs). Nothing else crosses.
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Anything that is not this app belongs in the real browser — without this,
  // clicking a published article traps the operator in a chrome-less window
  // with no way back.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_URL)) { e.preventDefault(); shell.openExternal(url); }
  });

  win.once('ready-to-show', () => win.show());
  return win;
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  createWindow();
  if (!repo) {
    dialog.showErrorBox('Cannot find the Command Center source',
      'This app runs the repo it lives in, so the source can be edited.\n\n' +
      'Keep the app inside the repo (desktop/out/…), or set NYYON_REPO to the repo path.');
    app.quit();
    return;
  }
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH));

  // "Is this install ready" is not just "are the packages there". A database
  // with no tables fails later and further away — the operator meets it as
  // "no such table: install_state" while trying to create their account,
  // which tells them nothing. Miniflare names its SQLite file from the D1
  // binding, so anything that changes that name (editing wrangler.jsonc,
  // switching branches) silently swaps in an empty database that setup would
  // otherwise skip. Check for the file AND its contents.
  const depsMissing = !existsSync(path.join(apiDir, 'node_modules')) || !existsSync(path.join(webDir, 'node_modules'));
  const dbReady = (() => {
    try {
      const d1 = path.join(apiDir, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
      if (!existsSync(d1)) return false;
      const files = require('node:fs').readdirSync(d1).filter((f) => f.endsWith('.sqlite'));
      // An empty SQLite file is a few KB of header; a migrated one is far
      // bigger. Cheap, and it needs no sqlite binding in the shell process.
      return files.some((f) => require('node:fs').statSync(path.join(d1, f)).size > 200_000);
    } catch { return false; }
  })();
  const firstRun = depsMissing || !dbReady;

  try {
    if (firstRun) {
      progress(2, 'preparing', depsMissing
        ? 'First launch sets everything up. This takes a few minutes, once.'
        : 'Preparing your database.');
      if (depsMissing) {
        // The honest weights: dependencies really are most of a cold start.
        await runStep('npm', ['install', '--no-audit', '--no-fund'], apiDir,
          { from: 3, to: 42, label: 'installing dependencies', hint: 'Fetching the worker packages.' });
        await runStep('npm', ['install', '--no-audit', '--no-fund'], webDir,
          { from: 42, to: 70, label: 'installing dependencies', hint: 'Fetching the web app packages.' });
        await runStep('npm', ['run', 'build'], webDir,
          { from: 70, to: 82, label: 'building the app', hint: '' });
      }
      await runStep('node', [path.join('scripts', 'setup.mjs')], repo,
        { from: depsMissing ? 82 : 10, to: 92, label: 'creating your database', hint: 'Schema, migrations, workflows and knowledge.' });
    } else {
      progress(20, 'starting', '');
    }

    // Before spawning anything: a busy port here used to hang the splash at
    // 40% with the real error buried in a log file.
    await assertPortsFree();

    progress(firstRun ? 93 : 45, 'starting the engine', '');
    startServer('api', ['wrangler', 'dev', '--port', String(API_PORT), '--local'], apiDir);
    startServer('web', ['vite', '--port', String(WEB_PORT)], webDir);

    // The WhatsApp daemon is best-effort, unlike the two above. It is not
    // needed to open the app, only to use Outreach, so a missing install or a
    // crash here must not stop the operator getting to their command center —
    // the module gate reports the connection as down, which is honest and
    // recoverable. Skipped when its dependencies or its generated key are
    // absent, rather than spawning something guaranteed to exit.
    if (!waDir || !existsSync(path.join(waDir, 'node_modules')) || !existsSync(path.join(waDir, '.dev.vars'))) {
      // Expected on a fresh install, not a fault: the service is installed on
      // demand the first time somebody opens Outreach and asks to connect it.
      log('[wa] not installed yet — it is set up on demand from Outreach');
    } else if (await portBusy(WA_PORT)) {
      // Someone is already on 2785 — most likely a wa-gateway the operator
      // runs themselves, which will own the paired session and the history.
      // Starting a second one would only crash-loop against a bound port, so
      // defer to whatever is there; the worker talks to the port, not to us.
      log(`[wa] port ${WA_PORT} already in use — using the gateway that is already running`);
    } else {
      startServer('wa', ['node', 'src/index.js'], waDir);
    }

    progress(firstRun ? 96 : 70, 'waiting for the app', '');
    await waitForServer(APP_URL);
    progress(100, 'ready', '');

    if (!quitting) win.loadURL(APP_URL);
  } catch (e) {
    progress(100, 'failed', '');
    dialog.showErrorBox('Could not start Nyyon Command Center',
      `${e.message}\n\nRun "npm run setup" then "npm start" in ${repo} to see the full output.`);
  }
}

// ── on-demand services ──────────────────────────────────────────────────────
//
// Installed when the operator asks for them, not on first run. The WhatsApp
// service alone is ~525 MB of Chromium (whatsapp-web.js → Puppeteer), which is
// most of the install time and wasted on everyone who never opens Outreach.
//
// The name is looked up in this table rather than used as a path. The renderer
// is a web page — treating a string it sends as a directory would be how you
// turn a UI bug into arbitrary code execution.
const SERVICES = {
  whatsapp: {
    dir: () => waDir,
    label: 'WhatsApp',
    // Chromium is the reason this is worth warning about in the UI.
    heavy: true,
    start: () => startServer('wa', ['node', 'src/index.js'], waDir),
  },
};

function serviceState(name) {
  const svc = SERVICES[name];
  if (!svc) return { installed: false, running: false, error: 'unknown service' };
  const dir = svc.dir();
  return {
    installed: !!dir && existsSync(path.join(dir, 'node_modules')),
    // `children` holds what we spawned; a service the operator runs themselves
    // is not ours and is reported separately by the port check at startup.
    running: children.some((c) => c.__name === name),
    paired: !!dir && existsSync(path.join(dir, '.dev.vars')),
    heavy: !!svc.heavy,
  };
}

ipcMain.handle('service:status', (_e, name) => serviceState(String(name || '')));

ipcMain.handle('service:install', async (_e, rawName) => {
  const name = String(rawName || '');
  const svc = SERVICES[name];
  if (!svc) return { ok: false, error: `unknown service "${name}"` };
  const dir = svc.dir();
  if (!dir || !existsSync(dir)) return { ok: false, error: `${svc.label} is not part of this install` };

  const send = (pct, label) => {
    try { win?.webContents.send('service:progress', { name, pct, label }); } catch { /* window gone */ }
  };

  try {
    if (!existsSync(path.join(dir, 'node_modules'))) {
      // Deliberately not runStep(): that drives the BOOT splash, which is long
      // gone by the time anyone clicks this. Progress goes to the page that
      // asked, over the same channel it is already listening on.
      await new Promise((resolve, reject) => {
        send(5, 'downloading, this one is large');
        const child = spawnTool('npm', 'npm', ['install', '--no-audit', '--no-fund'], dir);
        let pct = 5;
        const bump = (buf) => {
          log(`[service:${name}] ${buf}`);
          // npm emits no percentages, so advance on activity and stay under
          // the ceiling — never claim it finished early.
          pct = Math.min(88, pct + 2);
          send(pct, 'downloading, this one is large');
        };
        child.stdout.on('data', bump);
        child.stderr.on('data', bump);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited ${code}`))));
        child.on('error', reject);
      });
    }
    send(92, 'starting');
    if (await portBusy(WA_PORT)) {
      // Someone already owns the port (often a gateway the operator runs
      // themselves). Report success: the worker talks to the port either way.
      log(`[service:${name}] port ${WA_PORT} already in use, leaving it alone`);
    } else {
      svc.start();
    }
    send(100, 'ready');
    return { ok: true, ...serviceState(name) };
  } catch (e) {
    log(`[service:${name}] install failed: ${e.message}`);
    send(100, 'failed');
    return { ok: false, error: e.message };
  }
});

function stopServers() {
  quitting = true;
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* already gone */ } }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && existsSync(ICON)) {
    try { app.dock.setIcon(ICON); } catch { /* not fatal */ }
  }
  boot();
});
app.on('window-all-closed', () => { stopServers(); app.quit(); });
app.on('before-quit', stopServers);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot(); });
