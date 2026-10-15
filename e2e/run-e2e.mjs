// End-to-end check of Virga's scratches in a real VS Code with an isolated
// profile: own --user-data-dir and --extensions-dir under e2e/, the extension
// loaded from source (FROM_VSIX=1: installed from the packaged .vsix),
// e2e/fake-sf-langs (registers apex, apex-anon and soql like the Salesforce
// Extension Pack) and e2e/driver, which runs e2e/suite in the window and
// quits. The workspace e2e/ws is a throwaway SFDX project whose default org is
// VIRGA_TEST_ORG (an org authorized in sf); runs only query and System.debug.
// ONLY_SHOTS=1 takes the README screenshots instead (e2e/shots, fake sf).
//
// No --extensionTestsPath: in extension-test mode VS Code answers its own
// "save changes?" dialog with "Don't Save" without showing it. Here dialogs
// are real and native; e2e/dialog-watch.ps1 logs and dismisses every one, so
// a dialog fails the run instead of hanging it. Key presses (Ctrl+S, Ctrl+F4,
// typed text) go in through the Chrome DevTools protocol, like a keyboard.
//
// The default keymap pass also loads e2e/.cache/sf-snippets, a stand-in that
// contributes the Salesforce Extension Pack's Apex and SOQL snippets the way
// the pack does (prepareSfSnippets), and checks that no suggestion label comes
// from both Virga and the pack.
//
// Passes: the default keymap (whole suite), then the IntelliJ IDEA keymap
// (k--kato.intellij-idea-keybindings, where Ctrl+S is Save All) for the key
// checks. SKIP_INTELLIJ=1 skips that one. Each of the two ends by closing the
// window right after typing into a scratch; files.hotExit is off in the
// profile, so only the scratch's auto save can keep VS Code from asking. The
// main pass closes another scratch during its run just before, and once VS
// Code has exited this script checks that only the scratch still open at the
// close is left and that the run's temporary copy is gone.
//
// Then a restart in two runs on one profile (SKIP_RESTORE=1 skips it), with
// window.restoreWindows = all and hot exit on, so VS Code restores the tabs:
// run A leaves three scratches open (two groups, a background tab, a preview
// tab) and quits; this script deletes the file of the one that was in front
// (the bug of 2026-10-14: its tab came back, its file did not, and Salesforce
// Code Analyzer reported a file that does not exist); run B starts VS Code
// again and checks that no tab is left on the scratch folder, nothing was
// shown, a scratch closed while e2e/fake-analyzer (Code Analyzer's
// analyze-on-open path) still reads it raises no "does not exist" error, a
// new scratch still runs on Ctrl+S, and no scratch file is left once the
// grace period is over and after VS Code exited. e2e/probe (activates with
// VS Code) logs what other extensions saw meanwhile.
//
// Last, two windows on one project (SKIP_MULTI=1 skips them): the folder and
// a .code-workspace with it, a Reload Window while the other window touches
// the scratches, and a restart where the second workspace's tabs come back
// to files the first window's leftover sweep left alone (see multiPasses).
//
// Uses VSCODE_EXE when set, else e2e/vsc/Code.exe (a copy of the installed VS
// Code) when present, so a pending update of the real installation is never
// touched, else the installed VS Code. VS Code registers
// its urlProtocol as the Windows handler on every start; the copy must use its
// own (ensureOwnUrlProtocol), or vscode:// links (sign-in callbacks) would open
// the copy with the user's real profile.
//
// Run it only through e2e/hidden-desktop.ps1 (npm run e2e does: e2e/e2e.ps1),
// which keeps every window on a desktop that is never shown.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ext = path.resolve(here, '..');
const ws = path.join(here, 'ws');
const udd = path.join(here, 'udd');
const ipc = path.join(here, 'ipc');
// FROM_VSIX=1: test the packaged extension installed into e2e/exts-vsix instead of the source folder.
const fromVsix = process.env.FROM_VSIX === '1';
const exts = path.join(here, fromVsix ? 'exts-vsix' : 'exts');
const out = path.join(here, 'e2e-out.json');
// ONLY_SHOTS=1: no checks, just the README screenshots (e2e/shots), with a fake sf
// (e2e/shots/fake-sf) and a made-up org alias, copied to ../images at the end.
const onlyShots = process.env.ONLY_SHOTS === '1';
const wantShots = process.env.SHOTS === '1' || onlyShots;
const SHOTS_ORG = 'devSandbox';
const SHOTS_OUT = path.join(here, 'shots-out');
const SHOT_NAMES = ['scratch-run', 'local-type-completion', 'raw-list-quick-fix'];
// The org every run goes to: VIRGA_TEST_ORG, an org authorized in sf (runs only query and System.debug).
const org = onlyShots ? SHOTS_ORG : (process.env.VIRGA_TEST_ORG || '').trim();
if (!org) {
  console.error('Set VIRGA_TEST_ORG to the alias of an org authorized in sf (sf org login web --alias <alias>).\nThe e2e runs real anonymous Apex (System.debug only) and SOQL queries there.');
  process.exit(2);
}

const installed = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Microsoft VS Code', 'Code.exe');
const exeGiven = process.env.VSCODE_EXE || (fs.existsSync(path.join(here, 'vsc', 'Code.exe')) ? path.join(here, 'vsc', 'Code.exe') : installed);
// e2e/vsc may be a junction to a copy elsewhere: dialog-watch.ps1 matches windows by the real image path.
const exe = fs.existsSync(exeGiven) ? fs.realpathSync.native(exeGiven) : exeGiven;
const E2E_URL_PROTOCOL = 'vscode-virga-e2e';

/** resources/app of the VS Code build next to `exe` (<version dir>/resources/app). */
function appDirOf(codeExe) {
  const dir = path.dirname(codeExe);
  const version = fs.readdirSync(dir).find((d) => fs.existsSync(path.join(dir, d, 'resources', 'app', 'product.json')));
  return version ? path.join(dir, version, 'resources', 'app') : null;
}

/**
 * A copy of VS Code keeps product.json's urlProtocol ("vscode") and would make
 * itself the handler of vscode:// links on start. Give the copy its own.
 */
function ensureOwnUrlProtocol() {
  if (path.resolve(exe).toLowerCase() === path.resolve(installed).toLowerCase()) return; // the real install registers itself anyway
  const appDir = appDirOf(exe);
  if (!appDir) throw new Error(`no resources/app/product.json next to ${exe}`);
  const file = path.join(appDir, 'product.json');
  const product = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (product.urlProtocol === E2E_URL_PROTOCOL || /-e2e$/.test(product.urlProtocol || '')) return; // a test copy with its own already
  product.urlProtocol = E2E_URL_PROTOCOL;
  fs.writeFileSync(file, JSON.stringify(product, null, '\t'));
  console.log(`${file}: urlProtocol set to ${E2E_URL_PROTOCOL}`);
}

// The IntelliJ IDEA keymap extension (k--kato.intellij-idea-keybindings), loaded read-only as a
// development extension: VIRGA_INTELLIJ_KEYMAP (its folder), else the newest copy installed in ~/.vscode/extensions.
function findIntellijKeymap() {
  if (process.env.VIRGA_INTELLIJ_KEYMAP) return process.env.VIRGA_INTELLIJ_KEYMAP;
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const found = fs.readdirSync(dir).filter((d) => /^k--kato\.intellij-idea-keybindings-\d/.test(d))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
    return found ? path.join(dir, found) : null;
  } catch (err) {
    return null;
  }
}
const intellij = [findIntellijKeymap()].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'package.json')));

function freshWorkspace({ settings = {}, leftovers = true } = {}) {
  for (const dir of [ws, udd, ipc]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(ipc, { recursive: true });
  fs.mkdirSync(path.join(ws, '.sf'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'force-app'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '64.0' }, null, 2));
  fs.writeFileSync(path.join(ws, '.sf', 'config.json'), JSON.stringify({ 'target-org': org }, null, 2));
  if (leftovers) {
    // Crash leftovers: an old scratch (must go), a foreign file (must stay).
    const scratch = path.join(ws, '.sfdx', 'virga-scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    fs.writeFileSync(path.join(scratch, 'scratch-7.apex'), "System.debug('leftover');\n");
    fs.utimesSync(path.join(scratch, 'scratch-7.apex'), hourAgo, hourAgo);
    fs.writeFileSync(path.join(scratch, 'keep.txt'), 'not a scratch\n');
    fs.utimesSync(path.join(scratch, 'keep.txt'), hourAgo, hourAgo);
    // Named like a scratch but outside the scratch folder: must never be deleted.
    fs.writeFileSync(path.join(ws, 'force-app', 'scratch-1.apex'), "System.debug('not mine');\n");
    fs.utimesSync(path.join(ws, 'force-app', 'scratch-1.apex'), hourAgo, hourAgo);
  }

  // Isolated profile settings. The copied VS Code sits in a path past MAX_PATH,
  // where Chromium cannot load the background tokenizer worker, so tokenize on
  // the main thread (only matters for the screenshots). Native dialogs, so the
  // watcher sees them (also the default).
  fs.mkdirSync(path.join(udd, 'User'), { recursive: true });
  fs.writeFileSync(path.join(udd, 'User', 'settings.json'), JSON.stringify({
    'editor.experimental.asyncTokenization': false,
    'workbench.startupEditor': 'none',
    'window.restoreWindows': 'none',
    'window.dialogStyle': 'native',
    'files.hotExit': 'off', // closing the window asks about every dirty file that is not auto-saved
    'files.autoSave': 'off', // explicit user setting: the extension's [apex-anon]/[soql] default must still win
    'files.trimTrailingWhitespace': true, // a save of the run itself (an explicit save) would show: it trims the cursor line too
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'telemetry.telemetryLevel': 'off',
    ...settings,
  }, null, 2));
}

/** A run that goes on with the profile and the workspace of the previous one (a restart): only the request folder is new. */
function sameWorkspace() {
  fs.rmSync(ipc, { recursive: true, force: true });
  fs.mkdirSync(ipc, { recursive: true });
}

const scratchFolder = path.join(ws, '.sfdx', 'virga-scratch');
function scratchFilesLeft() {
  try {
    return fs.readdirSync(scratchFolder).filter((n) => /^scratch-\d+\.(apex|soql)$/i.test(n));
  } catch (err) {
    return [];
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// keyboard through the Chrome DevTools protocol
// ---------------------------------------------------------------------------

const NAMED_KEYS = {
  f4: { key: 'F4', code: 'F4', vk: 115 },
  enter: { key: 'Enter', code: 'Enter', vk: 13 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
};

function keySpec(spec) {
  const parts = spec.toLowerCase().split('+');
  const name = parts.pop();
  const mods = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const modifiers = parts.reduce((a, p) => a | mods[p], 0);
  if (NAMED_KEYS[name]) return { modifiers, ...NAMED_KEYS[name] };
  return { modifiers, key: name, code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0) };
}

async function cdpSession(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /workbench\.html/.test(t.url));
  if (!page) throw new Error(`no workbench page: ${list.map((t) => `${t.type} ${t.url}`).join(', ')}`);
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.onopen = resolve;
    sock.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  sock.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    sock.send(JSON.stringify({ id, method, params }));
  });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { send, close: () => sock.close() };
}

/**
 * Plays steps [{key:'ctrl+s'} | {text:'abc'} | {waitMs:n} | {evaluate:'js'}] back to back;
 * returns the time of each step and the values of the evaluations (run in the workbench page).
 */
async function playInput(port, steps) {
  const s = await cdpSession(port);
  const times = [];
  const values = [];
  const t0 = performance.now();
  try {
    for (const step of steps) {
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
      else if (step.evaluate) {
        const r = await s.send('Runtime.evaluate', { expression: step.evaluate, awaitPromise: true, returnByValue: true });
        if (r.error || (r.result && r.result.exceptionDetails)) throw new Error(JSON.stringify(r.error || r.result.exceptionDetails));
        values.push(r.result.result.value);
      } else if (step.text !== undefined) {
        const r = await s.send('Input.insertText', { text: step.text });
        if (r.error) throw new Error(JSON.stringify(r.error));
      } else if (step.key) {
        const k = keySpec(step.key);
        const base = { modifiers: k.modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
        const r1 = await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
        const r2 = await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        if (r1.error || r2.error) throw new Error(JSON.stringify([r1.error, r2.error]));
      }
      times.push(Math.round((performance.now() - t0) * 10) / 10);
    }
  } finally {
    s.close();
  }
  return { ok: true, times, values };
}

// ---------------------------------------------------------------------------
// one VS Code run
// ---------------------------------------------------------------------------

function startDialogWatcher(logFile) {
  fs.writeFileSync(logFile, '');
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'dialog-watch.ps1'), '-ExePath', exe, '-LogFile', logFile, '-OwnerParentPid', String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let text = '';
  const ready = new Promise((resolve) => {
    const onData = (d) => {
      text += d;
      if (/ready/.test(text)) resolve();
      if (/dialog:/.test(String(d))) console.log(`  ${String(d).trim()}`);
    };
    ps.stdout.on('data', onData);
    ps.stderr.on('data', (d) => { text += d; });
    setTimeout(resolve, 20000);
  });
  return { ready, stop: () => spawnSync('taskkill', ['/pid', String(ps.pid), '/T', '/F'], { windowsHide: true }), output: () => text };
}

function readDialogs(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    return [];
  }
}

async function runPass(pass) {
  if (pass.sameWorkspace) sameWorkspace();
  else freshWorkspace(pass.workspace);
  if (pass.before) pass.before();
  const passOut = path.join(here, `e2e-out-${pass.mode}.json`);
  const dialogLog = path.join(here, `dialogs-${pass.mode}.jsonl`);
  fs.rmSync(passOut, { force: true });
  const shots = SHOTS_OUT;
  if (pass.mode === 'main') fs.rmSync(shots, { recursive: true, force: true });
  if (wantShots && pass.mode === 'main') fs.mkdirSync(shots, { recursive: true });
  const port = await freePort();

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VSCODE_|ELECTRON_)/i.test(k)) continue;
    env[k] = v;
  }
  if (onlyShots) {
    // The fake sf answers every run with recorded output; nothing reaches an org.
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = [path.join(here, 'shots', 'fake-sf'), path.dirname(process.execPath), env[pathKey] || ''].join(path.delimiter);
  }
  const suite = onlyShots ? path.join(here, 'shots', 'index.js') : (process.env.E2E_SUITE ? path.resolve(process.env.E2E_SUITE) : path.join(here, 'suite', 'index.js'));
  Object.assign(env, {
    VIRGA_TEST_ORG: org,
    VIRGA_E2E_SHOTS_DIR: shots,
    VIRGA_E2E_OUT: passOut,
    VIRGA_E2E_UDD: udd,
    VIRGA_E2E_SUITE: suite,
    VIRGA_E2E_MODE: pass.mode,
    VIRGA_E2E_IPC: ipc,
    VIRGA_E2E_DIALOGS: dialogLog,
    VIRGA_E2E_PROBE: path.join(ipc, 'probe.jsonl'),
    VIRGA_E2E_ANALYZER: path.join(ipc, 'analyzer.jsonl'),
    VIRGA_E2E_ANALYZER_MS: '8000',
  });
  if (wantShots && pass.mode === 'main') env.VIRGA_E2E_SHOTS = '1';
  if (onlyShots) env.VIRGA_E2E_ONLY_SHOTS = '1';
  if (pass.packSnippets) env.VIRGA_E2E_PACK_SNIPPETS = pass.packSnippets;

  const args = [
    ...(fromVsix ? [] : [`--extensionDevelopmentPath=${ext}`]),
    `--extensionDevelopmentPath=${path.join(here, 'fake-sf-langs')}`,
    `--extensionDevelopmentPath=${path.join(here, 'driver')}`,
    ...(pass.probe ? [`--extensionDevelopmentPath=${path.join(here, 'probe')}`] : []),
    ...(pass.analyzer ? [`--extensionDevelopmentPath=${path.join(here, 'fake-analyzer')}`] : []),
    ...pass.dev.map((d) => `--extensionDevelopmentPath=${d}`),
    ...(onlyShots && grammars ? [`--extensionDevelopmentPath=${grammars}`] : []),
    `--user-data-dir=${udd}`,
    `--extensions-dir=${exts}`,
    `--remote-debugging-port=${port}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
    '--disable-updates',
    '--new-window',
    ws,
  ];

  const watcher = startDialogWatcher(dialogLog);
  await watcher.ready;
  console.log(`\n=== ${pass.name} (VS Code ${exe}, CDP port ${port})`);
  const t0 = Date.now();
  const p = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.log('timeout, killing VS Code');
    spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
  }, 9 * 60 * 1000);

  // Requests from the suite: ipc/input-<n>.json {steps} -> ipc/inputres-<n>.json
  let busy = false;
  const inputPoll = setInterval(async () => {
    if (busy) return;
    const req = fs.readdirSync(ipc).find((f) => /^input-\d+\.json$/.test(f));
    if (!req) return;
    busy = true;
    const n = req.match(/\d+/)[0];
    const { steps } = JSON.parse(fs.readFileSync(path.join(ipc, req), 'utf8'));
    fs.rmSync(path.join(ipc, req));
    let res;
    try {
      res = await playInput(port, steps);
    } catch (err) {
      res = { ok: false, error: String((err && err.stack) || err) };
    }
    const resFile = path.join(ipc, `inputres-${n}.json`);
    fs.writeFileSync(`${resFile}.tmp`, JSON.stringify(res));
    fs.renameSync(`${resFile}.tmp`, resFile); // the suite never reads half a file
    busy = false;
  }, 20);

  // Screenshot requests from the suite: shots-out/request-<name> -> shots-out/<name>.png + shots-out/done-<name>;
  // request-resize@<w>x<h> only sets the window's outer size (physical pixels).
  let shooting = false;
  const shotPoll = wantShots ? setInterval(() => {
    if (shooting || !fs.existsSync(shots)) return;
    const req = fs.readdirSync(shots).find((f) => f.startsWith('request-'));
    if (!req) return;
    shooting = true;
    const name = req.slice('request-'.length);
    let opts = {}; // the request file may hold { cropTop: <device pixels cut from the top> }
    try {
      opts = JSON.parse(fs.readFileSync(path.join(shots, req), 'utf8') || '{}');
    } catch (err) {
      opts = {};
    }
    fs.rmSync(path.join(shots, req), { force: true });
    const size = /^resize@(\d+)x(\d+)$/.exec(name);
    const shotArgs = size
      ? ['-Width', size[1], '-Height', size[2], '-ResizeOnly']
      : ['-OutFile', path.join(shots, `${name}.png`), ...(opts.cropTop ? ['-CropTop', String(Math.round(opts.cropTop))] : [])];
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'capture-window.ps1'), '-ExePath', exe, ...shotArgs], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let msg = '';
    ps.stdout.on('data', (d) => { msg += d; });
    ps.stderr.on('data', (d) => { msg += d; });
    ps.on('exit', () => {
      console.log(`screenshot ${name}: ${msg.trim()}`);
      fs.writeFileSync(path.join(shots, `done-${name}`), msg);
      shooting = false;
    });
  }, 200) : null;

  const code = await new Promise((resolve) => p.on('exit', resolve));
  clearTimeout(timer);
  clearInterval(inputPoll);
  if (shotPoll) clearInterval(shotPoll);
  await new Promise((r) => setTimeout(r, 1500)); // a dialog shown while quitting gets logged first
  watcher.stop();
  fs.writeFileSync(path.join(here, `e2e-host-${pass.mode}.log`), log);

  let results = [];
  try {
    results = JSON.parse(fs.readFileSync(passOut, 'utf8'));
  } catch (err) {
    results = [{ name: 'suite wrote results', ok: false, detail: 'no results file' }];
  }
  // The suite closed the window right after typing into a scratch (ipc/window-close.json says which and what).
  const closeMarker = path.join(ipc, 'window-close.json');
  if (fs.existsSync(closeMarker)) {
    const m = JSON.parse(fs.readFileSync(closeMarker, 'utf8'));
    let onDisk = null;
    try {
      onDisk = fs.readFileSync(m.file, 'utf8');
    } catch (err) {
      onDisk = null;
    }
    results.push({
      name: 'window close: the text typed just before closing is on disk (auto save on shutdown, hot exit off)',
      ok: onDisk === m.text,
      detail: onDisk === m.text ? undefined : JSON.stringify({ expected: m.text, onDisk, dirtyAtClose: m.dirtyAtClose }),
    });
    // After VS Code is gone: only the scratch still open at the close is left (its tab would come back).
    let left = [];
    try {
      left = fs.readdirSync(path.dirname(m.file)).filter((n) => /^scratch-\d+\.(apex|soql)$/i.test(n));
    } catch (err) {
      left = [];
    }
    const keep = (m.keep || []).map((n) => n.toLowerCase());
    const extra = left.filter((n) => !keep.includes(n.toLowerCase()));
    results.push({
      name: `after VS Code exited: no scratch file of a closed tab is left${m.closedFile ? ' (one was closed during its run)' : ''}`,
      ok: extra.length === 0,
      detail: extra.length ? JSON.stringify({ left, keep: m.keep }) : undefined,
    });
    if (m.graceFile) {
      results.push({
        name: 'after VS Code exited: the scratch closed shortly before, still in its grace period, is gone too',
        ok: !fs.existsSync(m.graceFile),
        detail: fs.existsSync(m.graceFile) ? m.graceFile : undefined,
      });
    }
    if (m.runFile) {
      const runDir = path.dirname(m.runFile);
      results.push({
        name: `after VS Code exited: the temporary copy of the run ${m.runningAtClose ? 'still going at the close' : 'that had finished'} is gone`,
        ok: !fs.existsSync(runDir),
        detail: fs.existsSync(runDir) ? runDir : undefined,
      });
    }
  }
  if (pass.after) pass.after(results);
  const dialogs = readDialogs(dialogLog);
  const lastStep = results.filter((r) => r.name.startsWith('window close:')).length;
  results.push({
    name: `no VS Code dialog appeared during the whole run${lastStep ? ', closing the window included' : ''}`,
    ok: dialogs.length === 0,
    detail: dialogs.length ? JSON.stringify(dialogs, null, 1) : undefined,
  });
  results.push({ name: 'VS Code finished on its own', ok: !timedOut, detail: timedOut ? 'killed after the timeout' : undefined });
  const errors = log.split('\n').filter((l) => /virga/i.test(l) && /error|warn|fail/i.test(l));
  console.log(`${pass.name}: VS Code exit ${code}; ${((Date.now() - t0) / 1000).toFixed(0)} s${errors.length ? `\nhost log lines mentioning the extension:\n${errors.slice(0, 20).join('\n')}` : ''}`);
  return results.map((r) => (pass.prefix ? { ...r, name: `${pass.prefix}${r.name}` } : r));
}

// ---------------------------------------------------------------------------

/**
 * Screenshots only: a throwaway development extension in e2e/.cache/sf-grammars
 * that gives apex, apex-anon and soql the TextMate grammars of the Salesforce
 * extensions installed in ~/.vscode/extensions (read from there, never
 * shipped), so code in the screenshots is highlighted as users see it. No
 * language servers. Null when they are not installed: the shots work without.
 */
function prepareGrammars() {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  const newest = (prefix) => {
    try {
      const found = fs.readdirSync(dir).filter((d) => d.startsWith(prefix) && /^\d+\.\d+\.\d+$/.test(d.slice(prefix.length)))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
      return found ? path.join(dir, found) : null;
    } catch (err) {
      return null;
    }
  };
  const apex = newest('salesforce.salesforcedx-vscode-apex-');
  const soql = newest('salesforce.salesforcedx-vscode-soql-');
  const apexGrammar = apex && path.join(apex, 'grammars', 'apex.tmLanguage');
  const soqlGrammar = soql && path.join(soql, 'grammars', 'soql.tmLanguage');
  if (!apexGrammar || !fs.existsSync(apexGrammar)) {
    console.log('Salesforce Apex extension not found in ~/.vscode/extensions: screenshots without syntax colors');
    return null;
  }
  const target = path.join(here, '.cache', 'sf-grammars');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(apexGrammar, path.join(target, 'apex.tmLanguage'));
  const grammars = [
    { language: 'apex', scopeName: 'source.apex', path: './apex.tmLanguage' },
    { language: 'apex-anon', scopeName: 'source.apex', path: './apex.tmLanguage' },
  ];
  if (soqlGrammar && fs.existsSync(soqlGrammar)) {
    fs.copyFileSync(soqlGrammar, path.join(target, 'soql.tmLanguage'));
    grammars.push({ language: 'soql', scopeName: 'source.soql', path: './soql.tmLanguage' });
  }
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    name: 'virga-e2e-sf-grammars',
    displayName: 'Virga screenshots: Salesforce grammars from the local install',
    version: '0.0.1',
    publisher: 'test',
    engines: { vscode: '^1.90.0' },
    contributes: { grammars },
  }, null, 2));
  return target;
}

/**
 * The default keymap pass: a throwaway development extension in
 * e2e/.cache/sf-snippets that contributes the Salesforce Extension Pack's
 * Apex and SOQL snippets exactly as salesforce.apex-language-server-extension
 * does (same language/path pairs), so the suite can check that no Virga
 * snippet shows up next to one of the pack's with the same label. The snippet
 * files come from the copy installed in ~/.vscode/extensions (read from
 * there, never committed or shipped); without one, from the prefixes recorded
 * in test/fixtures/sf-pack-snippets.json with placeholder bodies.
 * Returns { dir, info } (info: the file the suite reads: source, prefixes per language).
 */
function prepareSfSnippets() {
  const { findInstalled, readPackSnippets } = require(path.join(ext, 'tools', 'record-pack-snippets.js'));
  const target = path.join(here, '.cache', 'sf-snippets');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'snippets'), { recursive: true });
  const installed = findInstalled();
  let rec;
  let source;
  if (installed) {
    rec = readPackSnippets(installed);
    source = `installed ${rec.extension} ${rec.version}`;
    for (const p of new Set(rec.snippets.map((s) => s.path))) fs.copyFileSync(path.join(installed, p), path.join(target, 'snippets', path.basename(p)));
  } else {
    rec = JSON.parse(fs.readFileSync(path.join(ext, 'test', 'fixtures', 'sf-pack-snippets.json'), 'utf8'));
    source = `recorded ${rec.extension} ${rec.version}`;
    for (const [p, prefixes] of Object.entries(rec.prefixes)) {
      const file = Object.fromEntries(prefixes.map((prefix, i) => [`${prefix} ${i}`, { prefix, body: `${prefix}$0`, description: 'stand-in' }]));
      fs.writeFileSync(path.join(target, 'snippets', path.basename(p)), JSON.stringify(file, null, 2));
    }
  }
  const snippets = rec.snippets.map((s) => ({ language: s.language, path: `./snippets/${path.basename(s.path)}` }));
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    name: 'virga-e2e-sf-snippets',
    displayName: 'Virga e2e: the Extension Pack snippets',
    version: '0.0.1',
    publisher: 'test',
    engines: { vscode: '^1.90.0' },
    contributes: { snippets },
  }, null, 2));
  // label -> how many snippets of the pack carry it, per language (what the suite expects to see once)
  const counts = {};
  for (const { language, path: p } of snippets) {
    const file = JSON.parse(fs.readFileSync(path.join(target, p), 'utf8'));
    counts[language] = counts[language] || Object.create(null); // prefixes such as "constructor"
    for (const s of Object.values(file)) for (const prefix of [].concat(s.prefix)) counts[language][prefix] = (counts[language][prefix] || 0) + 1;
  }
  const info = path.join(target, 'info.json');
  fs.writeFileSync(info, JSON.stringify({ source, counts }, null, 1));
  return { dir: target, info };
}

fs.rmSync(out, { force: true });
ensureOwnUrlProtocol();
const grammars = onlyShots ? prepareGrammars() : null;
const sfSnippets = onlyShots ? null : prepareSfSnippets();
if (fromVsix) {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
  const vsix = process.env.VSIX ? path.resolve(process.env.VSIX) : path.join(ext, `${name}-${version}.vsix`);
  if (!fs.existsSync(vsix)) {
    console.error(`${vsix} not found: run npm run package first`);
    process.exit(2);
  }
  fs.rmSync(exts, { recursive: true, force: true });
  const cli = path.join(appDirOf(exe), 'out', 'cli.js');
  const res = spawnSync(exe, [cli, `--user-data-dir=${udd}`, `--extensions-dir=${exts}`, '--install-extension', vsix, '--force'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  console.log(`install ${path.basename(vsix)}: ${(res.stdout + res.stderr).trim()}`);
}

const SHOTS_SETTINGS = {
  'editor.fontSize': 15,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.layoutControl.enabled': false,
  'chat.commandCenter.enabled': false,
  'chat.disableAIFeatures': true,
  'window.commandCenter': false,
  'workbench.tips.enabled': false,
};
const passes = onlyShots
  ? [{ name: 'README screenshots (fake sf)', mode: 'main', dev: [], prefix: '', workspace: { leftovers: false, settings: SHOTS_SETTINGS } }]
  : [{ name: 'default keymap', mode: 'main', dev: [sfSnippets.dir], prefix: '', packSnippets: sfSnippets.info }];
if (!onlyShots && process.env.SKIP_INTELLIJ !== '1' && !process.env.E2E_SUITE) {
  if (intellij) passes.push({ name: 'IntelliJ IDEA keymap', mode: 'intellij', dev: [intellij], prefix: '[IntelliJ keymap] ' });
  else console.log('IntelliJ keymap not found (~/.vscode/extensions or VIRGA_INTELLIJ_KEYMAP): second pass skipped');
}
if (!onlyShots && process.env.SKIP_RESTORE !== '1' && !process.env.E2E_SUITE) passes.push(...restorePasses());
if (!onlyShots && process.env.SKIP_MULTI !== '1' && !process.env.E2E_SUITE) passes.push(...multiPasses());

/**
 * A restart of VS Code with scratch tabs open. Run A quits with three
 * scratches open; in between, the file of the one in front is deleted; run B
 * starts VS Code again on the same profile and workspace (restored tabs).
 */
function restorePasses() {
  // VS Code restores the windows and the editors of the last session; hot exit as it is by default.
  const workspace = { leftovers: false, settings: { 'window.restoreWindows': 'all', 'files.hotExit': 'onExit' } };
  let expect = null;
  const phaseA = {
    name: 'restart, run A: scratches open when VS Code quits',
    mode: 'restore-a',
    dev: [],
    prefix: '[restart A] ',
    workspace,
    after(results) {
      let m = null;
      try {
        m = JSON.parse(fs.readFileSync(path.join(ipc, 'restore-a.json'), 'utf8'));
      } catch (err) {
        results.push({ name: 'run A listed the scratches it left open', ok: false, detail: String(err) });
        return;
      }
      const onDisk = Object.fromEntries(Object.keys(m.files).map((n) => {
        try {
          return [n, fs.readFileSync(path.join(scratchFolder, n), 'utf8')];
        } catch (err) {
          return [n, null];
        }
      }));
      const kept = Object.entries(m.files).every(([n, text]) => onDisk[n] === text);
      results.push({
        name: 'after VS Code quit: the files of the scratches still open are there, with their text (VS Code restores their tabs)',
        ok: kept,
        detail: kept ? undefined : JSON.stringify({ expected: m.files, onDisk }),
      });
      // The state of 2026-10-14 21:22: the tab of the scratch in front comes back, its file does not.
      fs.rmSync(path.join(scratchFolder, m.front), { force: true });
      expect = { missing: [m.front], restored: Object.keys(m.files).filter((n) => n !== m.front).sort() };
    },
  };
  const phaseB = {
    name: 'restart, run B: VS Code started again with the tabs it restores',
    mode: 'restore-b',
    dev: [],
    prefix: '[restart B] ',
    sameWorkspace: true,
    probe: true,
    analyzer: true,
    before() {
      fs.writeFileSync(path.join(ipc, 'restore-b.json'), JSON.stringify(expect || { missing: [], restored: [], runAFailed: true }));
    },
    after(results) {
      const left = scratchFilesLeft();
      results.push({ name: 'after VS Code exited: no scratch file left', ok: left.length === 0, detail: left.length ? left.join(', ') : undefined });
    },
  };
  return [phaseA, phaseB];
}

/**
 * Two windows on one project in two runs on one profile: the folder (window 1)
 * and proj.code-workspace (window 2, which window 1 opens). A: window 1
 * reloads while window 2 closes a scratch in the gap, then window 2 closes its
 * window with two scratches open and window 1 quits with one. In between, the
 * files are made an hour old (leftover age). B: the folder again, then window
 * 2's workspace: see the suite (multiSuite).
 */
function multiPasses() {
  const workspace = { leftovers: false, settings: { 'window.restoreWindows': 'all', 'files.hotExit': 'onExit' } };
  const phaseA = {
    name: 'two windows, run A: Reload Window while the other window closes a scratch',
    mode: 'multi-a',
    dev: [],
    prefix: '[two windows A] ',
    workspace,
    after(results) {
      const left = scratchFilesLeft().sort();
      results.push({
        name: 'after VS Code exited: the scratches still open in either window are there, the closed one is not',
        ok: JSON.stringify(left) === JSON.stringify(['scratch-1.apex', 'scratch-3.apex']),
        detail: JSON.stringify(left),
      });
      const hourAgo = new Date(Date.now() - 3600 * 1000);
      for (const n of left) fs.utimesSync(path.join(scratchFolder, n), hourAgo, hourAgo);
    },
  };
  const phaseB = {
    name: 'two windows, run B: the folder again, then the other workspace',
    mode: 'multi-b',
    dev: [],
    prefix: '[two windows B] ',
    sameWorkspace: true,
    after(results) {
      const left = scratchFilesLeft();
      results.push({ name: 'after VS Code exited: no scratch file left', ok: left.length === 0, detail: left.length ? left.join(', ') : undefined });
    },
  };
  return [phaseA, phaseB];
}

const t0 = Date.now();
const all = [];
for (const pass of passes) all.push(...await runPass(pass));
if (onlyShots) {
  // The README screenshots: copied to ../images only when all of them were taken.
  const taken = SHOT_NAMES.filter((n) => fs.existsSync(path.join(SHOTS_OUT, `${n}.png`)));
  const complete = taken.length === SHOT_NAMES.length && all.every((r) => r.ok);
  if (complete) for (const n of SHOT_NAMES) fs.copyFileSync(path.join(SHOTS_OUT, `${n}.png`), path.join(ext, 'images', `${n}.png`));
  all.push({ name: `screenshots ${SHOT_NAMES.join(', ')} taken and copied to images/`, ok: complete, detail: complete ? undefined : `taken: ${taken.join(', ') || 'none'}` });
}
fs.writeFileSync(out, JSON.stringify(all, null, 1));
console.log('');
for (const r of all) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `\n       ${String(r.detail).split('\n').join('\n       ')}` : ''}`);
}
const failed = all.filter((r) => !r.ok).length;
console.log(`\n${all.length - failed} passed, ${failed} failed; ${passes.length} VS Code run(s)${fromVsix ? ' from the .vsix' : ''}; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
