'use strict';

// Pure logic of Virga's scratches. No `vscode` import, so the unit tests load it
// as is: scratch paths, running `sf`, parsing its JSON and the Apex debug log,
// and turning results into the text shown in the "Virga" output channel.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Scratch files
// ---------------------------------------------------------------------------

const SCRATCH_SEGMENTS = ['.sfdx', 'virga-scratch'];
const SCRATCH_FILE = /^scratch-(\d{1,6})\.(apex|soql)$/i;

const KINDS = {
  apex: { ext: '.apex', language: 'apex-anon', label: 'Apex' },
  soql: { ext: '.soql', language: 'soql', label: 'SOQL' },
};

function scratchDir(root) {
  return path.join(root, ...SCRATCH_SEGMENTS);
}

function comparable(p, platform) {
  const resolved = path.resolve(String(p));
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  return comparable(a, platform) === comparable(b, platform);
}

/** 'apex' | 'soql' for a file named like a scratch (scratch-3.apex), else null. */
function scratchKind(filePath) {
  const m = SCRATCH_FILE.exec(path.basename(String(filePath || '')));
  return m ? m[2].toLowerCase() : null;
}

/**
 * True only for files this extension creates: scratch-<n>.apex|.soql sitting
 * directly in `dir`. Everything that deletes files goes through this check.
 */
function isScratchFile(filePath, dir, platform = process.platform) {
  if (!filePath || !dir || !scratchKind(filePath)) return false;
  return samePath(path.dirname(path.resolve(String(filePath))), dir, platform);
}

function nextScratchNumber(kind, names, floor = 0) {
  let max = Math.max(0, Number(floor) || 0);
  for (const name of names || []) {
    const m = SCRATCH_FILE.exec(path.basename(String(name)));
    if (m && m[2].toLowerCase() === kind) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function scratchFileName(kind, n) {
  return `scratch-${n}${KINDS[kind].ext}`;
}

// ---------------------------------------------------------------------------
// Which window shows which scratch
//
// Two windows can have the same project open. Each window keeps an owner file
// in the scratch folder listing the scratches it keeps (its tabs show them),
// and no window deletes a scratch that another one still needs. The file is
// named after the window (ownerFileName), so the next extension host of the
// same window (a reload, Restart Extensions, a crashed host coming back) finds
// it, takes those scratches over and writes over it. It also records the
// window's workspace (a folder, or a .code-workspace file): VS Code restores a
// workspace's tabs only into a window of that workspace, so that window alone
// takes over the scratches a closed window of the same workspace left behind.
//
// What another window's owner file means is ownerRole's call. A window that
// ended keeps its claim (its scratches stay on disk) until its own window or
// workspace comes back and takes them over, or until its VS Code has exited
// and PARKED_MAX_AGE_MS have passed: until then the next start of that
// workspace restores the tabs and needs their files.
// ---------------------------------------------------------------------------

// .owner-w<16 hex>.json: a window (hash of its log folder); .owner-<pid>.json:
// a host whose window is unknown (remote hosts, --logsPath), or one written without a workspace.
const OWNER_FILE = /^\.owner-(?:w[0-9a-f]{16}|(\d+))\.json$/;
// <user data>/logs/<session>/window<N>/exthost/<extension id>: context.logUri of a local extension host.
const HOST_LOG = /^(.*[\\/]logs)[\\/]([^\\/]+)[\\/](window\d+)[\\/]exthost(?:[\\/]|$)/i;
// How long the scratches of a window that ended wait for its workspace after its VS Code exited.
const PARKED_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM'; // exists, belongs to someone else
  }
}

/**
 * The window an extension host serves, from its log folder (context.logUri):
 * { logsHome, session, window }, or null for any other layout (remote hosts,
 * --logsPath). VS Code opens a new <session> folder on every start and keeps
 * a window's window<N> folder across a reload and an extension host restart.
 */
function hostIdentity(logPath, platform = process.platform) {
  if (!logPath) return null;
  const m = HOST_LOG.exec(String(logPath));
  if (!m) return null;
  const norm = (p) => (platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p);
  return { logsHome: norm(m[1]), session: norm(m[2]), window: norm(m[3]) };
}

function sameWindow(a, b) {
  return !!a && !!b && a.logsHome === b.logsHome && a.session === b.session && a.window === b.window;
}

/**
 * True when the VS Code that `owner` ran in has exited: same user data folder
 * (only one VS Code runs per user data folder), another session. Its process
 * id may be alive again, now belonging to some other program.
 */
function sessionOver(owner, self) {
  return !!owner && !!self && owner.logsHome === self.logsHome && owner.session !== self.session;
}

/** The owner file of the window `host` serves; of the process `pid` when the window is unknown. */
function ownerFileName(host, pid = process.pid) {
  const id = hostIdentity(host);
  if (!id) return `.owner-${pid}.json`;
  const hash = crypto.createHash('sha1').update(`${id.logsHome}\n${id.session}\n${id.window}`).digest('hex').slice(0, 16);
  return `.owner-w${hash}.json`;
}

/** One owner file: { file, pid, host, workspace, files (lower-cased; null when unreadable), mtimeMs }; null when there is none. */
function readOwnerFile(file) {
  const m = OWNER_FILE.exec(path.basename(String(file)));
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    return null;
  }
  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    json = null;
  }
  const pid = json && Number.isInteger(json.pid) ? json.pid : (m && m[1] ? Number(m[1]) : null);
  return {
    file,
    pid,
    host: json && typeof json.host === 'string' ? json.host : null,
    workspace: json && typeof json.workspace === 'string' ? json.workspace : null,
    files: json && Array.isArray(json.files) ? json.files.map((n) => String(n).toLowerCase()) : null,
    mtimeMs,
  };
}

/** The owner files in `dir`, except `ownName` (this host's own). */
function readOwners(dir, ownName = null) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
  const owners = [];
  for (const name of names) {
    if (!OWNER_FILE.test(name) || (ownName && name.toLowerCase() === ownName.toLowerCase())) continue;
    const owner = readOwnerFile(path.join(dir, name));
    if (owner) owners.push(owner);
  }
  return owners;
}

/**
 * What another host's owner file means to this one (`self`: { pid, host, workspace }):
 * - 'live': that host runs; its window shows these scratches.
 * - 'previous': an earlier host of this same window (reload, extension host
 *   restart); its scratches are this window's.
 * - 'heir': ended, same VS Code, same workspace: this window took its place
 *   (VS Code restores a workspace's tabs only into a window of that workspace).
 * - 'parked': ended, and its scratches may still be wanted: a window of this
 *   session (maybe in the middle of a reload), or a window of another
 *   workspace whose tabs come back when that workspace opens again.
 * - 'gone': nothing comes back for it: its window is unknown, it was written
 *   without a workspace in an earlier session, or its VS Code exited more
 *   than PARKED_MAX_AGE_MS ago.
 */
function ownerRole(owner, self, { isAlive = isProcessAlive, now = Date.now(), parkedMaxAgeMs = PARKED_MAX_AGE_MS } = {}) {
  const id = hostIdentity(owner.host);
  const me = hostIdentity(self && self.host);
  if (owner.pid === null) return 'gone'; // unreadable and no process id in its name: no host ever wrote it whole
  if (sameWindow(id, me)) return 'previous'; // a window has one extension host at a time: this one took over
  if (!sessionOver(id, me) && isAlive(owner.pid)) return 'live';
  if (!id) return 'gone';
  const sameVsCode = !!me && id.logsHome === me.logsHome;
  if (sameVsCode && owner.workspace && self.workspace && owner.workspace === self.workspace) return 'heir';
  if (sameVsCode && id.session === me.session) return 'parked';
  if (!owner.workspace) return 'gone';
  return now - owner.mtimeMs > parkedMaxAgeMs ? 'gone' : 'parked';
}

/** readOwners with each owner's role for `self` (ownerRole); this host's own file is left out. */
function ownersOf(dir, self, opts = {}) {
  return readOwners(dir, ownerFileName(self && self.host, self && self.pid)).map((o) => ({ ...o, role: ownerRole(o, self, opts) }));
}

/** Lower-cased scratch names that the owners with one of `roles` list; '*' when such an owner's list cannot be read. */
function claimedNames(owners, roles) {
  const claimed = new Set();
  for (const owner of owners) {
    if (!roles.includes(owner.role)) continue;
    if (!owner.files) claimed.add('*');
    else owner.files.forEach((n) => claimed.add(n));
  }
  return claimed;
}

/** Records the scratch names this window keeps; removes its owner file when there are none. */
function writeClaims(dir, names, selfPid = process.pid, selfHost = null, workspace = null) {
  const file = path.join(dir, ownerFileName(selfHost, selfPid));
  try {
    if (names.length) {
      const tmp = `${file}.${selfPid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: selfPid, host: selfHost || null, workspace: workspace || null, files: names }));
      fs.renameSync(tmp, file); // readers never see half a file
    } else {
      fs.unlinkSync(file);
    }
  } catch (err) {
    // no folder (no scratches) or already gone
  }
}

/** Dates this window's owner file now: the last moment the window was seen (PARKED_MAX_AGE_MS counts from it). */
function touchClaims(dir, selfPid = process.pid, selfHost = null) {
  try {
    const now = new Date();
    fs.utimesSync(path.join(dir, ownerFileName(selfHost, selfPid)), now, now);
  } catch (err) {
    // no owner file: nothing claimed
  }
}

/** Removes the scratch folder (and nothing else) when it is empty. */
function removeDirIfEmpty(dir) {
  try {
    fs.rmdirSync(dir);
  } catch (err) {
    // not empty or gone
  }
}

// ---------------------------------------------------------------------------
// What a run executes
//
// A run takes the editor text at the moment of Ctrl+S and gives sf a copy of
// it in its own temporary folder, <tmp>/virga-run-<pid>-XXXXXX/. sf
// never reads the scratch file itself, so a run neither waits for nor causes a
// save (no save participants), keys typed after Ctrl+S are not part of it, and
// whatever VS Code's background save left on disk does not matter. The folder
// goes when the run ends; folders of extension hosts that died mid-run are
// swept at the next start.
// ---------------------------------------------------------------------------

const RUN_DIR = /^virga-run-(\d+)-[^\\/]+$/;

/** Writes `text` to <tmpDir>/virga-run-<pid>-XXXXXX/<scratch file name>; returns that path. */
function writeRunFile(scratchFile, text, opts = {}) {
  const tmp = opts.tmpDir || os.tmpdir();
  const pid = opts.pid || process.pid;
  const dir = fs.mkdtempSync(path.join(tmp, `virga-run-${pid}-`));
  const file = path.join(dir, path.basename(String(scratchFile)));
  try {
    fs.writeFileSync(file, String(text), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    removeRunFile(file);
    throw err;
  }
  return file;
}

/** Removes the run folder holding `runFile` (only a folder named like one writeRunFile makes). */
function removeRunFile(runFile) {
  if (!runFile) return false;
  const dir = path.dirname(String(runFile));
  if (!RUN_DIR.test(path.basename(dir))) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    return !fs.existsSync(dir);
  } catch (err) {
    return false; // still open somewhere: the next start sweeps it
  }
}

/** Run folders in `tmp` left by extension hosts that are gone (killed mid-run). Returns the names removed. */
function sweepRunDirs(tmp = os.tmpdir(), selfPid = process.pid, isAlive = isProcessAlive) {
  let names = [];
  try {
    names = fs.readdirSync(tmp);
  } catch (err) {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const m = RUN_DIR.exec(name);
    if (!m || Number(m[1]) === selfPid || isAlive(Number(m[1]))) continue;
    try {
      if (!fs.lstatSync(path.join(tmp, name)).isDirectory()) continue;
      fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      // in use or gone
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Output size
// ---------------------------------------------------------------------------

/**
 * Text for the output channel, at most `max` characters: earlier runs are
 * dropped whole (from a header line on), and a block that is too long by
 * itself keeps its head (header, status) and is cut at a line boundary.
 */
function fitOutput(previous, block, max) {
  let b = String(block);
  if (b.length > max) {
    const note = `\n… output cut at ${max} characters\n`;
    let cut = b.lastIndexOf('\n', max - note.length);
    if (cut <= 0) cut = Math.max(0, max - note.length);
    b = b.slice(0, cut) + note;
  }
  let p = String(previous || '');
  const room = max - b.length;
  if (p.length > room) {
    const at = p.indexOf('\n▶ ', p.length - room - 1);
    p = at >= 0 ? p.slice(at + 1) : '';
  }
  return p + b;
}

/** Text of a new scratch plus the selection [line, ch, line, ch] to put the cursor on. */
function initialContent(kind, org) {
  if (kind === 'soql') {
    // SOQL has no comments, so the hint lives in the status bar tooltip.
    return { text: 'SELECT Id, Name FROM Account LIMIT 10\n', selection: [0, 7, 0, 15] };
  }
  const where = org ? org : 'the default org';
  return {
    text: `// Ctrl+S runs this in ${where}. Close the tab to discard.\n\n`,
    selection: [2, 0, 2, 0],
  };
}

/** LF line endings: SOQL field completion inside the language server breaks on CRLF. */
function toLf(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

function stripBom(text) {
  return String(text).replace(/^\u{FEFF}/u, '');
}

function readJson(file, readFile) {
  try {
    return JSON.parse(stripBom(readFile(file, 'utf8')));
  } catch (err) {
    return null;
  }
}

/**
 * The org `sf` would pick from `root`, in sf's own order: SF_TARGET_ORG (or
 * the deprecated SFDX_DEFAULTUSERNAME) from the environment, project config,
 * then global config. The extension passes the result as --target-org, so
 * the org named in the header is always the org that runs the code.
 */
function readTargetOrg(root, home, readFile = fs.readFileSync, env = process.env) {
  for (const name of ['SF_TARGET_ORG', 'SFDX_DEFAULTUSERNAME']) {
    const value = envGet(env, name);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const candidates = [];
  if (root) {
    candidates.push([path.join(root, '.sf', 'config.json'), 'target-org']);
    candidates.push([path.join(root, '.sfdx', 'sfdx-config.json'), 'defaultusername']);
  }
  if (home) {
    candidates.push([path.join(home, '.sf', 'config.json'), 'target-org']);
    candidates.push([path.join(home, '.sfdx', 'sfdx-config.json'), 'defaultusername']);
  }
  for (const [file, key] of candidates) {
    const json = readJson(file, readFile);
    const value = json && json[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locating and spawning sf
// ---------------------------------------------------------------------------

function envGet(env, name) {
  const key = Object.keys(env || {}).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

/** Same lookup cmd.exe does: every PATH entry, every PATHEXT extension. */
function findExecutable(name, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const exists = opts.exists || isFile;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = String(envGet(env, 'PATH') || '')
    .split(platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const exts = platform === 'win32'
    ? String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// cmd.exe metacharacters. Port of cross-spawn's escaping (used by npm and execa):
// quote for the C runtime's argv parser, then ^-escape every metacharacter so
// cmd never interprets &, |, %, ^, parentheses or quotes. A .cmd/.bat target
// gets a second ^ level because cmd parses the batch file's %* line again.
// The command itself is not quoted, so `=` (a cmd token delimiter like space,
// `,` and `;`) is escaped there too: C:\tools\a=b\sf.cmd would otherwise run "C:\tools\a".
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const CMD_META_COMMAND = /([()\][%!^"`<>&|;, *?=])/g;
const CMD_SAFE = /^[A-Za-z0-9_\-.\\/:]+$/;

function quoteCmdArg(arg, doubleEscape = false) {
  let s = String(arg);
  if (s && CMD_SAFE.test(s)) return s;
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META, '^$1');
  if (doubleEscape) s = s.replace(CMD_META, '^$1');
  return s;
}

function quoteCmdCommand(file) {
  return path.win32.normalize(String(file)).replace(CMD_META_COMMAND, '^$1');
}

function buildCmdLine(file, args) {
  const doubleEscape = /\.(cmd|bat)$/i.test(String(file));
  return [quoteCmdCommand(file), ...args.map((a) => quoteCmdArg(a, doubleEscape))].join(' ');
}

const SF_RUN_JS = ['node_modules', '@salesforce', 'cli', 'bin', 'run.js'];

/**
 * How to spawn sf. On Windows sf is a .cmd shim, and Node >= 18.20 / 20.12
 * refuses to spawn .cmd/.bat without a shell (EINVAL, CVE-2024-27980).
 *
 * 1. npm install (`npm i -g @salesforce/cli`, also under fnm/nvm): the shim
 *    only runs `node <dir>\node_modules\@salesforce\cli\bin\run.js %*`, so
 *    that is spawned directly, without cmd.exe. Arguments reach sf as they
 *    are, and a UNC working directory (\\server\share\proj) works, which
 *    cmd.exe refuses.
 * 2. Anything else (the Salesforce installer's sf.cmd): through cmd.exe
 *    (`shell: true`) with every argument escaped.
 */
function sfSpawnSpec(exe, args, platform = process.platform, opts = {}) {
  if (platform === 'win32' && !/\.(exe|com)$/i.test(exe)) {
    const exists = opts.exists || isFile;
    const dir = path.win32.dirname(String(exe));
    const runJs = path.win32.join(dir, ...SF_RUN_JS);
    if (/\.cmd$/i.test(exe) && exists(runJs)) {
      const bundled = path.win32.join(dir, 'node.exe');
      const node = exists(bundled) ? bundled : findExecutable('node', { env: opts.env, platform, exists });
      if (node && /\.(exe|com)$/i.test(node)) {
        return { shell: false, command: node, args: ['--no-deprecation', runJs, ...args] };
      }
    }
    return { shell: true, command: buildCmdLine(exe, args), args: [] };
  }
  return { shell: false, command: exe, args: args.slice() };
}

// setTimeout fires at once (with a TimeoutOverflowWarning) above 2^31-1 ms.
const MAX_TIMEOUT_MS = 2147483647;

// Keeps sf quiet and machine readable: JSON errors on stdout, no update checks, no colors.
// SF_DISABLE_TELEMETRY: sf reports command usage to Salesforce unless it is off (its own
// disable-telemetry config, which this env var overrides for the run); runs started by Virga send none.
const SF_ENV = {
  SF_JSON_TO_STDOUT: 'true',
  SF_SKIP_NEW_VERSION_CHECK: 'true',
  SF_DISABLE_AUTOUPDATE: 'true',
  SF_AUTOUPDATE_DISABLE: 'true',
  SF_DISABLE_TELEMETRY: 'true',
  FORCE_COLOR: '0',
};

function killTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (platform === 'win32' && child.pid) {
      // cmd.exe -> node: killing cmd alone would leave sf running.
      const k = childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch (e) { /* gone */ } });
    } else {
      child.kill('SIGTERM');
    }
  } catch (err) {
    // already gone
  }
}

/**
 * Starts `sf <args>` and returns { done, kill }. `done` never rejects; it
 * resolves to { code, stdout, stderr, timedOut, notFound, error, exe }.
 */
function startSf(args, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const spawnFn = opts.spawn || childProcess.spawn;
  const timeoutMs = Math.min(Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000, MAX_TIMEOUT_MS);
  let child = null;
  let killRequested = false;

  const done = new Promise((resolve) => {
    const exe = opts.sfPath || findExecutable('sf', { env, platform });
    const base = { code: null, stdout: '', stderr: '', timedOut: false, notFound: false, error: null, exe, spec: null };
    if (!exe) {
      resolve({ ...base, notFound: true });
      return;
    }
    const spec = sfSpawnSpec(exe, args, platform, { env });
    base.spec = spec;
    const options = { cwd: opts.cwd, env: { ...env, ...SF_ENV }, windowsHide: true, shell: spec.shell };
    try {
      child = spec.shell ? spawnFn(spec.command, options) : spawnFn(spec.command, spec.args, options);
    } catch (err) {
      resolve({ ...base, error: err });
      return;
    }
    const out = [];
    const errOut = [];
    if (child.stdout) child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    if (child.stderr) child.stderr.on('data', (d) => errOut.push(Buffer.from(d)));
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, platform);
    }, timeoutMs);
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...base,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
        timedOut,
        killed: killRequested,
        ...extra,
      });
    };
    child.on('error', (err) => finish({ error: err, notFound: !!(err && err.code === 'ENOENT') }));
    child.on('close', (code) => finish({ code }));
    if (killRequested) killTree(child, platform);
  });

  return {
    done,
    kill() {
      killRequested = true;
      if (child) killTree(child, platform);
    },
  };
}

function runSf(args, opts) {
  return startSf(args, opts).done;
}

// ---------------------------------------------------------------------------
// sf JSON
// ---------------------------------------------------------------------------

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** sf --json body from stdout (or stderr), tolerating noise printed around it. */
function parseSfJson(stdout, stderr) {
  for (const raw of [stdout, stderr]) {
    const text = stripAnsi(raw).trim();
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch (err) {
      // fall through to the embedded-object search
    }
    const start = text.search(/^\{/m);
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (err) {
        // not JSON either
      }
    }
  }
  return null;
}

function toInt(v) {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * `sf apex run --json`: success is {status: 0, result}, failures exit 1 with
 * the same object under `data` (sf 2.x), so both places are checked.
 */
function interpretApexJson(json) {
  if (!json || typeof json !== 'object') return null;
  const hasResult = (o) => o && typeof o === 'object' && 'compiled' in o;
  const r = hasResult(json.result) ? json.result : hasResult(json.data) ? json.data : null;
  const warnings = Array.isArray(json.warnings) ? json.warnings : [];
  if (r) {
    const base = { logs: String(r.logs || ''), line: toInt(r.line), column: toInt(r.column), warnings };
    if (r.compiled === false) return { type: 'compile', problem: r.compileProblem || json.message || '', ...base };
    if (r.success === false) {
      return { type: 'exception', message: r.exceptionMessage || json.message || '', stack: String(r.exceptionStackTrace || ''), ...base };
    }
    return { type: 'success', ...base };
  }
  return { type: 'error', name: json.name || json.code || 'Error', message: String(json.message || ''), actions: json.actions || [], warnings };
}

function interpretSoqlJson(json) {
  if (!json || typeof json !== 'object') return null;
  const warnings = Array.isArray(json.warnings) ? json.warnings : [];
  const r = json.result;
  if ((json.status === 0 || json.status === undefined) && r && Array.isArray(r.records)) {
    return {
      type: 'records',
      records: r.records,
      totalSize: typeof r.totalSize === 'number' ? r.totalSize : r.records.length,
      done: r.done !== false,
      warnings,
    };
  }
  const data = json.data && typeof json.data === 'object' ? json.data : {};
  return {
    type: 'error',
    name: json.name || data.errorCode || 'Error',
    code: data.errorCode || json.name || 'Error',
    message: String(json.message || data.message || ''),
    actions: json.actions || [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Apex debug log
// ---------------------------------------------------------------------------

// "12:36:47.39 (40221823)|USER_DEBUG|[3]|DEBUG|hello 42"
const LOG_EVENT = /^\d{1,2}:\d{2}:\d{2}\.\d+ \(\d+\)\|([A-Z][A-Z0-9_]*)(?:\|(.*))?$/;
const LIMIT_LINE = /^\s*(.+?):\s*(\d+)\s+out of\s+(\d+)/;

function parseLogEvents(logs) {
  const events = [];
  let current = null;
  for (const raw of String(logs || '').split(/\r?\n/)) {
    const m = LOG_EVENT.exec(raw);
    if (m) {
      current = { type: m[1], text: m[2] === undefined ? '' : m[2], extra: [] };
      events.push(current);
    } else if (current) {
      current.extra.push(raw); // continuation of a multi-line event
    }
  }
  return events;
}

function parseLimitLines(lines) {
  const limits = {};
  for (const line of lines) {
    const m = LIMIT_LINE.exec(line);
    if (m) limits[m[1].trim()] = { used: Number(m[2]), max: Number(m[3]) };
  }
  return Object.keys(limits).length ? limits : null;
}

/**
 * USER_DEBUG entries (multi-line messages kept) and the default namespace's cumulative limits.
 * Salesforce writes a `|` inside a debug message as `&#124;` (it is the log's field
 * separator; nothing else is encoded), so it is decoded once the fields are split off.
 */
function parseApexLog(logs) {
  const debugs = [];
  let limits = null;
  for (const ev of parseLogEvents(logs)) {
    if (ev.type === 'USER_DEBUG') {
      const m = /^\[([^\]]*)\]\|([A-Z]+)\|([\s\S]*)$/.exec(ev.text);
      const lines = [m ? m[3] : ev.text, ...ev.extra];
      while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
      debugs.push({
        line: m && /^\d+$/.test(m[1]) ? Number(m[1]) : null,
        level: m ? m[2] : 'DEBUG',
        message: lines.join('\n').replace(/&#124;/g, '|'),
      });
    } else if (ev.type === 'LIMIT_USAGE_FOR_NS') {
      const ns = ev.text.replace(/\|\s*$/, '').trim();
      if (ns === '(default)' || ns === '') {
        const parsed = parseLimitLines(ev.extra);
        if (parsed) limits = parsed; // the last block is the transaction total
      }
    }
  }
  return { debugs, limits };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// Emoji shown as emoji by default (East Asian Width W: grinning face, rocket, check
// mark button, star, cross mark, hot beverage, green circle, melting face) take two
// columns; text-style symbols such as the check mark, (c) and the play triangle take
// one unless a variation selector 16 (U+FE0F) asks for the emoji form.
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0e || cp === 0xfe0f) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  if (cp >= 0x2300 && EMOJI_PRESENTATION.test(String.fromCodePoint(cp))) return 2;
  return 1;
}

// Code points that glue onto the previous one: combining marks, variation
// selectors, skin tones, Hangul vowel/final jamo, and a zero-width joiner
// (which also glues the next code point on).
const EXTEND = /^[\p{M}\p{Emoji_Modifier}\u{1160}-\u{11FF}\u{200D}]$/u;
const REGIONAL = /^\p{Regional_Indicator}$/u;
const MAY_JOIN = /[\p{M}\p{Emoji_Modifier}\p{Regional_Indicator}\u{1160}-\u{11FF}\u{200D}]/u;
const ZWJ = '\u{200D}';
const VS15 = '\u{FE0E}';

/**
 * User-perceived characters, close enough for column widths: a family joined
 * with ZWJ, a thumbs-up with a skin tone, a flag and e + combining accent are
 * one each. (Intl.Segmenter does this fully but is ~50x slower on big tables.)
 */
function graphemes(s) {
  const text = String(s);
  const cps = Array.from(text);
  if (!MAY_JOIN.test(text)) return cps;
  const out = [];
  for (let i = 0; i < cps.length; i += 1) {
    let g = cps[i];
    if (REGIONAL.test(g) && i + 1 < cps.length && REGIONAL.test(cps[i + 1])) {
      i += 1;
      g += cps[i];
    }
    while (i + 1 < cps.length && (EXTEND.test(cps[i + 1]) || g.endsWith(ZWJ))) {
      i += 1;
      g += cps[i];
    }
    out.push(g);
  }
  return out;
}

function clusterWidth(g) {
  if (g.length === 1) return charWidth(g.charCodeAt(0));
  const cps = Array.from(g);
  if (cps.length > 1 && !g.includes(VS15) && PICTOGRAPHIC.test(g)) return 2; // emoji sequence, flag, heart + VS16
  let w = 0;
  for (const ch of cps) w += charWidth(ch.codePointAt(0));
  return w;
}

function textWidth(s) {
  const text = String(s);
  if (PLAIN_ASCII.test(text)) return text.length;
  let w = 0;
  for (const g of graphemes(text)) w += clusterWidth(g);
  return w;
}

/** At most `max` columns; a cut text ends with an ellipsis and never splits a character. */
function truncate(s, max) {
  const text = String(s);
  if (PLAIN_ASCII.test(text)) return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
  let cut = null;
  let w = 0;
  let out = '';
  for (const g of graphemes(text)) {
    const cw = clusterWidth(g);
    if (cut === null && w + cw > max - 1) cut = out;
    w += cw;
    if (w > max) return `${cut}…`;
    out += g;
  }
  return text;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clock(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
  const total = Math.round(v / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

function formatHeader(kind, org, date, ms) {
  const parts = [`▶ ${KINDS[kind] ? KINDS[kind].label : kind}`, org || 'default org', clock(date || new Date())];
  if (typeof ms === 'number') parts.push(formatDuration(ms));
  return parts.join(' · ');
}

function cleanMessage(message) {
  const lines = String(message || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, '').replace(/^\t+/, ''))
    .filter((l) => !/^See more help with --help$/i.test(l.trim()));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function warningLines(warnings) {
  return (warnings || []).map((w) => String(w && w.message ? w.message : w).trim()).filter(Boolean).map((w) => `⚠ ${w.replace(/\s*\n\s*/g, ' ')}`);
}

/** "  12 │ code" plus "     │    ^" under `column` (1-based; tabs kept so the caret lines up). */
function sourceSnippet(source, line, column) {
  if (!source) return [];
  const lines = String(source).split(/\r?\n/);
  if (!line || line < 1 || line > lines.length) return [];
  const text = lines[line - 1];
  const num = String(line);
  const out = [`  ${num} │ ${text}`];
  if (column && column >= 1) {
    const prefix = Array.from(text).slice(0, column - 1).map((ch) => (ch === '\t' ? '\t' : ' ')).join('');
    out.push(`  ${' '.repeat(num.length)} │ ${prefix}^`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apex output
// ---------------------------------------------------------------------------

// The output channel holds at most ~2,000,000 characters (extension.js), so a
// run that prints a lot keeps its header, status, exception and limits and
// gives the debug section a budget: the first two thirds and the last third
// of it are shown, with a note about what was left out in between.
const DEBUG_BUDGET_CHARS = 1500000;
const DEBUG_MESSAGE_MAX_CHARS = 100000;

function formatDebugs(debugs, opts = {}) {
  if (!debugs.length) return [];
  const budget = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : DEBUG_BUDGET_CHARS;
  const maxMessage = Number(opts.maxMessageChars) > 0 ? Number(opts.maxMessageChars) : DEBUG_MESSAGE_MAX_CHARS;
  const markers = debugs.map((d) => (d.line === null ? '[line ?]' : `[line ${d.line}]`));
  const markerWidth = Math.max(...markers.map((m) => m.length));
  const levelWidth = Math.max(5, ...debugs.map((d) => d.level.length));
  const indent = ' '.repeat(2 + markerWidth + 1 + levelWidth + 2);
  const entries = debugs.map((d, i) => {
    let message = String(d.message);
    if (message.length > maxMessage) message = `${message.slice(0, maxMessage)} … (${message.length - maxMessage} more characters)`;
    const [first, ...rest] = message.split('\n');
    const lines = [`  ${markers[i].padEnd(markerWidth)} ${d.level.padEnd(levelWidth)}  ${first}`.replace(/\s+$/, '')];
    for (const line of rest) lines.push((indent + line).replace(/\s+$/, ''));
    return { lines, size: lines.reduce((n, l) => n + l.length + 1, 0) };
  });
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= budget) return entries.flatMap((e) => e.lines);

  const headBudget = Math.floor((budget * 2) / 3);
  let head = 0;
  let used = 0;
  while (head < entries.length && (head === 0 || used + entries[head].size <= headBudget)) {
    used += entries[head].size;
    head += 1;
  }
  let tail = 0;
  used = 0;
  while (head + tail < entries.length && used + entries[entries.length - 1 - tail].size <= budget - headBudget) {
    used += entries[entries.length - 1 - tail].size;
    tail += 1;
  }
  const omitted = entries.length - head - tail;
  const out = entries.slice(0, head).flatMap((e) => e.lines);
  if (omitted > 0) out.push(`  … ${omitted} of ${entries.length} debug messages omitted (output limit)`);
  out.push(...entries.slice(entries.length - tail).flatMap((e) => e.lines));
  return out;
}

const MAIN_LIMITS = [
  ['Number of SOQL queries', 'SOQL queries', ''],
  ['Number of query rows', 'query rows', ''],
  ['Number of DML statements', 'DML statements', ''],
  ['Number of DML rows', 'DML rows', ''],
  ['Maximum CPU time', 'CPU time', ' ms'],
  ['Maximum heap size', 'heap', ' bytes'],
];

function formatLimits(limits) {
  if (!limits) return [];
  const item = (label, v, unit) => `${label} ${v.used}/${v.max}${unit}`;
  const first = [];
  const second = [];
  MAIN_LIMITS.forEach(([key, label, unit], i) => {
    if (limits[key]) (i < 4 ? first : second).push(item(label, limits[key], unit));
  });
  const known = new Set(MAIN_LIMITS.map((l) => l[0]));
  for (const [key, v] of Object.entries(limits)) {
    if (known.has(key) || !v.used) continue;
    second.push(item(key.replace(/^(Number of|Maximum)\s+/i, ''), v, ''));
  }
  const out = [];
  if (first.length) out.push(`  Limits  ${first.join(' · ')}`);
  if (second.length) out.push(`${first.length ? '          ' : '  Limits  '}${second.join(' · ')}`);
  return out;
}

function declaredTypes(source) {
  const names = new Set();
  const re = /\b(?:class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(String(source || '')))) names.add(m[1].toLowerCase());
  return names;
}

/** First stack frame that points into the scratch itself (AnonymousBlock or a class declared in it). */
function anonymousFrame(stack, source) {
  const declared = declaredTypes(source);
  for (const frame of String(stack || '').split(/\r?\n/)) {
    const m = /^\s*(AnonymousBlock|Class\.([A-Za-z_][A-Za-z0-9_]*)[^:]*):\s*line\s+(\d+),\s*column\s+(\d+)/i.exec(frame);
    if (!m) continue;
    if (/^anonymousblock$/i.test(m[1]) || (m[2] && declared.has(m[2].toLowerCase()))) {
      return { line: Number(m[3]), column: Number(m[4]) };
    }
  }
  return null;
}

function formatSfError(name, message, actions) {
  const lines = cleanMessage(message);
  const out = [lines.length ? `✖ ${name}: ${lines[0].trim()}` : `✖ ${name}`];
  for (const l of lines.slice(1)) out.push(`  ${l.trim()}`);
  for (const a of actions || []) out.push(`  → ${String(a).trim()}`);
  return out;
}

function formatApexOutcome(outcome, source, opts = {}) {
  if (!outcome) return ['✖ sf returned no result'];
  if (outcome.type === 'error') return [...formatSfError(outcome.name, outcome.message, outcome.actions), ...warningLines(outcome.warnings)];
  const out = [];
  const log = parseApexLog(outcome.logs);
  if (outcome.type === 'compile') {
    const where = outcome.line !== null && outcome.line > 0
      ? ` line ${outcome.line}${outcome.column !== null && outcome.column > 0 ? `, column ${outcome.column}` : ''}`
      : '';
    out.push(`✖ Compile error${where}: ${String(outcome.problem).trim()}`);
    const snippet = sourceSnippet(source, outcome.line, outcome.column);
    if (snippet.length) out.push('', ...snippet);
  } else if (outcome.type === 'exception') {
    const [first, ...rest] = cleanMessage(outcome.message);
    out.push(`✔ Compiled  ✖ Exception: ${(first || '').trim()}`);
    for (const l of rest) out.push(`  ${l.trim()}`);
    for (const frame of outcome.stack.split(/\r?\n/).map((f) => f.trim()).filter(Boolean)) out.push(`  at ${frame}`);
    const at = anonymousFrame(outcome.stack, source) || (outcome.stack ? null : { line: outcome.line, column: outcome.column });
    const snippet = at ? sourceSnippet(source, at.line, at.column) : [];
    if (snippet.length) out.push('', ...snippet);
    const debugs = formatDebugs(log.debugs, opts);
    if (debugs.length) out.push('', ...debugs);
  } else {
    out.push('✔ Compiled  ✔ Executed');
    out.push('');
    const debugs = formatDebugs(log.debugs, opts);
    out.push(...(debugs.length ? debugs : ['  (no debug output)']));
  }
  if (outcome.type !== 'compile') {
    const limits = formatLimits(log.limits);
    if (limits.length) out.push('', ...limits);
  }
  const warnings = warningLines(outcome.warnings);
  if (warnings.length) out.push('', ...warnings);
  return out;
}

// ---------------------------------------------------------------------------
// SOQL output
// ---------------------------------------------------------------------------

const MAX_TABLE_ROWS = 2000;
const TABLE_BUDGET_CHARS = 1500000;

function isSubquery(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.records)
    && ('totalSize' in v || 'done' in v);
}

function isRelationship(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !isSubquery(v)
    && !!v.attributes && typeof v.attributes === 'object';
}

function mergeShape(shape, obj) {
  for (const key of Object.keys(obj)) {
    if (key === 'attributes') continue;
    const v = obj[key];
    const node = shape.get(key);
    if (isSubquery(v)) {
      if (!node || node.type !== 'rel') shape.set(key, { type: 'sub' });
    } else if (isRelationship(v)) {
      let rel = node;
      if (!rel || rel.type !== 'rel') {
        rel = { type: 'rel', children: new Map() };
        shape.set(key, rel); // Map.set on an existing key keeps its position
      }
      mergeShape(rel.children, v);
    } else {
      const n = node || { type: 'value', seen: false };
      if (!node) shape.set(key, n);
      if (n.type === 'value' && v !== null && v !== undefined) n.seen = true; // a real value: hints never re-type it
    }
  }
}

// ---------------------------------------------------------------------------
// SOQL text -> column hints
//
// A subquery that is empty in every row comes back as `"Opportunities": null`,
// and a relationship that is null in every row as `"ReportsTo": null`, so the
// records alone cannot tell them from a plain null field. The SELECT list can.
// ---------------------------------------------------------------------------

const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

/** Top-level SELECT items and the object after the top-level FROM, or null. */
function splitSelect(query) {
  const text = String(query || '');
  const head = /^\s*SELECT\b/i.exec(text);
  if (!head) return null;
  const items = [];
  let depth = 0;
  let inTypeof = false;
  let start = head[0].length;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      i += 1;
      while (i < text.length && text[i] !== "'") i += text[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '(') {
      depth += 1;
      i += 1;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i += 1;
    } else if (ch === ',' && depth === 0 && !inTypeof) {
      items.push(text.slice(start, i));
      start = i + 1;
      i += 1;
    } else if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_.]/.test(text[i - 1] || ' ')) {
      WORD.lastIndex = i;
      const word = WORD.exec(text)[0];
      if (depth === 0) {
        const upper = word.toUpperCase();
        if (upper === 'TYPEOF') inTypeof = true;
        else if (upper === 'END' && inTypeof) inTypeof = false;
        else if (upper === 'FROM' && !inTypeof) {
          items.push(text.slice(start, i));
          const obj = /^FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(text.slice(i, i + 300));
          return { items: items.map((s) => s.trim()).filter(Boolean), from: obj ? obj[1] : null };
        }
      }
      i += word.length;
    } else {
      i += 1;
    }
  }
  return null;
}

/**
 * Hints from the query text: { sub: 'Contacts' } for a parenthesized subquery,
 * { path: ['ReportsTo', 'Account', 'Name'] } for a dotted field. Functions,
 * aliases and TYPEOF are left to the data.
 */
function soqlColumnHints(query) {
  const sel = splitSelect(query);
  if (!sel) return [];
  const hints = [];
  for (const item of sel.items) {
    if (item.startsWith('(') && item.endsWith(')')) {
      const sub = splitSelect(item.slice(1, -1));
      if (sub && sub.from) hints.push({ sub: sub.from });
    } else if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(item)) {
      hints.push({ path: item.split('.') });
    }
  }
  return hints;
}

function findKey(map, name) {
  if (map.has(name)) return name;
  const lower = name.toLowerCase();
  for (const k of map.keys()) if (k.toLowerCase() === lower) return k;
  return undefined;
}

/** Re-types columns that were null in every record, using the query's SELECT list. */
function applyHints(shape, hints) {
  for (const h of hints || []) {
    if (h.sub) {
      const k = findKey(shape, h.sub);
      const node = k === undefined ? null : shape.get(k);
      if (node && node.type === 'value' && !node.seen) node.type = 'sub';
      continue;
    }
    let map = shape;
    for (let i = 0; i < h.path.length; i += 1) {
      const last = i === h.path.length - 1;
      const k = findKey(map, h.path[i]);
      let node = k === undefined ? null : map.get(k);
      if (!node) {
        if (i === 0) break; // not a column of the result (aliased in an aggregate query)
        node = last ? { type: 'value', seen: false } : { type: 'rel', children: new Map() };
        map.set(h.path[i], node);
      } else if (!last && node.type === 'value' && !node.seen) {
        node.type = 'rel';
        node.children = new Map();
      }
      if (last || node.type !== 'rel') break;
      map = node.children;
    }
  }
}

function shapeColumns(shape, prefix) {
  const cols = [];
  for (const [key, node] of shape) {
    const p = [...prefix, key];
    if (node.type === 'rel' && node.children.size) cols.push(...shapeColumns(node.children, p));
    else cols.push({ path: p, type: node.type === 'sub' ? 'sub' : 'value', label: p.join('.') });
  }
  return cols;
}

function sanitizeCell(s) {
  return String(s).replace(/\r\n|\r|\n/g, '↵').replace(/\t/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function compactValue(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(compactValue).join(', ')}]`;
  if (typeof v === 'object') {
    const parts = [];
    for (const [k, x] of Object.entries(v)) {
      if (k === 'attributes' || x === null || x === undefined) continue;
      parts.push(`${k}=${compactValue(x)}`);
    }
    return `{${parts.join(', ')}}`;
  }
  return String(v);
}

function cellFor(record, col) {
  let v = record;
  for (const key of col.path) {
    if (v === null || v === undefined || typeof v !== 'object') {
      v = null;
      break;
    }
    v = v[key];
  }
  if (col.type === 'sub') {
    let n = 0;
    if (v && typeof v === 'object') n = typeof v.totalSize === 'number' ? v.totalSize : Array.isArray(v.records) ? v.records.length : 0;
    return { text: `[${n} ${n === 1 ? 'row' : 'rows'}]`, right: false };
  }
  if (v === undefined || v === null) return { text: 'null', right: false };
  if (typeof v === 'number') return { text: String(v), right: true };
  if (typeof v === 'object') return { text: sanitizeCell(compactValue(v)), right: false };
  return { text: sanitizeCell(v), right: false };
}

/**
 * Columns = union of fields in record order; relationships flattened to dotted
 * names. `hints` (soqlColumnHints) re-type columns that are null in every row.
 */
function flattenRecords(records, hints) {
  const shape = new Map();
  for (const rec of records) if (rec && typeof rec === 'object') mergeShape(shape, rec);
  applyHints(shape, hints);
  const columns = shapeColumns(shape, []);
  const rows = records.map((rec) => columns.map((c) => cellFor(rec, c)));
  return { columns, rows };
}

/** Cells truncated to the column limit, each with its display width (measured once). */
function prepareTable(headers, rows, maxColumnWidth) {
  const max = Math.max(4, Math.floor(Number(maxColumnWidth) || 40));
  const cell = (text, right) => {
    const t = truncate(text, max);
    return { text: t, right: !!right, w: textWidth(t) };
  };
  return {
    head: headers.map((h) => cell(sanitizeCell(h), false)),
    body: rows.map((r) => r.map((c) => cell(c.text, c.right))),
  };
}

function columnWidths(prepared) {
  return prepared.head.map((h, i) => prepared.body.reduce((w, r) => Math.max(w, r[i].w), h.w));
}

function renderPrepared(prepared) {
  const { head, body } = prepared;
  const widths = columnWidths(prepared);
  const fill = (c, i) => ' '.repeat(Math.max(0, widths[i] - c.w));
  const show = (c, i) => (c.right ? ` ${fill(c, i)}${c.text} ` : ` ${c.text}${fill(c, i)} `);
  const rule = (l, m, r) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const out = [rule('┌', '┬', '┐'), `│${head.map(show).join('│')}│`, rule('├', '┼', '┤')];
  for (const r of body) out.push(`│${r.map(show).join('│')}│`);
  out.push(rule('└', '┴', '┘'));
  return out;
}

function renderTable(headers, rows, maxColumnWidth) {
  return renderPrepared(prepareTable(headers, rows, maxColumnWidth));
}

/**
 * Where Salesforce's Row/Column lands in the file: sf sends the query with its
 * leading whitespace trimmed, so leading blank lines shift the row and the
 * first line's indentation shifts the column of row 1.
 */
function soqlErrorPosition(source, row, col) {
  const lead = /^\s*/.exec(String(source || ''))[0];
  const newlines = (lead.match(/\n/g) || []).length;
  const indent = lead.length - (lead.lastIndexOf('\n') + 1);
  return { line: row + newlines, column: row === 1 ? col + indent : col };
}

function formatSoqlError(outcome, source) {
  const m = /ERROR at Row:(\d+):Column:(\d+)\s*\n?([\s\S]*)$/.exec(outcome.message);
  if (!m) return formatSfError(outcome.name, outcome.message, outcome.actions);
  const description = m[3].trim().replace(/\s*\n\s*/g, ' ');
  const at = soqlErrorPosition(source, Number(m[1]), Number(m[2]));
  const out = [`✖ ${outcome.code} at row ${at.line}, column ${at.column}: ${description}`];
  const snippet = sourceSnippet(source, at.line, at.column);
  if (snippet.length) {
    out.push('', ...snippet);
  } else {
    const own = outcome.message.slice(0, m.index).split(/\r?\n/).filter((l) => l.trim());
    if (own.length) out.push('', ...own.map((l) => `  ${l}`));
  }
  return out;
}

function formatSoqlOutcome(outcome, source, opts = {}) {
  if (!outcome) return ['✖ sf returned no result'];
  if (outcome.type === 'error') return [...formatSoqlError(outcome, source), ...warningLines(outcome.warnings)];
  const { records, totalSize, done } = outcome;
  const out = [];
  if (!records.length) {
    out.push(totalSize > 0 ? `✔ ${totalSize} ${totalSize === 1 ? 'record' : 'records'} (count only)` : '✔ 0 records');
  } else {
    let summary = `✔ ${totalSize} ${totalSize === 1 ? 'record' : 'records'}`;
    if (!done) summary += ' (more available)';
    if (records.length < totalSize) summary += `, showing ${records.length}`;
    out.push(summary);
    const { columns, rows } = flattenRecords(records, soqlColumnHints(source));
    if (columns.length) {
      // A row cap, then a character budget so a wide result never overflows the channel.
      const prepared = prepareTable(columns.map((c) => c.label), rows.slice(0, opts.maxRows || MAX_TABLE_ROWS), opts.maxColumnWidth);
      const budget = Number(opts.maxTableChars) > 0 ? Number(opts.maxTableChars) : TABLE_BUDGET_CHARS;
      const lineChars = columnWidths(prepared).reduce((n, w) => n + w + 3, 1) + 1;
      const fit = Math.max(1, Math.floor(budget / lineChars) - 4);
      if (prepared.body.length > fit) prepared.body = prepared.body.slice(0, fit);
      out.push(...renderPrepared(prepared));
      if (rows.length > prepared.body.length) out.push(`… ${rows.length - prepared.body.length} more rows not shown`);
    }
  }
  const warnings = warningLines(outcome.warnings);
  if (warnings.length) out.push('', ...warnings);
  return out;
}

// ---------------------------------------------------------------------------
// One run: file -> sf -> lines
// ---------------------------------------------------------------------------

/** sf arguments: always the file path, never the text; --target-org when the org is known. */
function sfArgsFor(kind, fileArg, org) {
  const args = kind === 'apex'
    ? ['apex', 'run', '--file', fileArg]
    : ['data', 'query', '--file', fileArg];
  if (org) args.push('--target-org', org);
  args.push('--json');
  return args;
}

/**
 * Path relative to cwd when it is below it (only safe characters reach cmd.exe
 * then). Absolute for a UNC cwd: if sf ends up behind cmd.exe, cmd refuses a
 * UNC working directory and falls back to C:\Windows.
 */
function fileArgFor(cwd, filePath) {
  if (!cwd || /^[\\/]{2}/.test(String(cwd))) return filePath;
  const rel = path.relative(cwd, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return filePath;
}

function tail(text, max) {
  const lines = stripAnsi(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  return lines.slice(-max);
}

/** Pure: process result of sf -> output lines (no header). */
function formatRun(kind, proc, source, opts = {}) {
  if (proc.notFound) {
    return { ok: false, lines: ['✖ Salesforce CLI (sf) not found on PATH. Install it, then restart VS Code so the PATH is picked up.'] };
  }
  if (proc.timedOut) {
    const s = Math.round((Number(opts.timeoutMs) || 120000) / 1000);
    return { ok: false, lines: [`✖ Timed out after ${s} s (setting virga.scratch.timeoutSeconds); sf was stopped.`] };
  }
  if (proc.error) {
    return { ok: false, lines: [`✖ Could not start sf: ${proc.error.message || proc.error}`] };
  }
  const json = parseSfJson(proc.stdout, proc.stderr);
  if (!json) {
    const lines = [`✖ sf exited with code ${proc.code} without a JSON result`];
    const detail = tail(proc.stderr, 15);
    const more = detail.length ? detail : tail(proc.stdout, 15);
    for (const l of more) lines.push(`  ${l}`);
    return { ok: false, lines };
  }
  if (kind === 'apex') {
    const outcome = interpretApexJson(json);
    return { ok: !!outcome && outcome.type === 'success', outcome, lines: formatApexOutcome(outcome, source, opts) };
  }
  const outcome = interpretSoqlJson(json);
  return { ok: !!outcome && outcome.type === 'records', outcome, lines: formatSoqlOutcome(outcome, source, opts) };
}

/**
 * Runs one scratch file with sf and formats the result. Used by the extension
 * and by the integration test. Never rejects.
 * opts: { cwd, targetOrg, timeoutMs, maxColumnWidth, env, sfPath, source, onStart(handle) }
 * targetOrg: the org named in the header; resolved like sf does when left out
 * (null runs without --target-org).
 */
async function runScratch(filePath, opts = {}) {
  const started = Date.now();
  const kind = scratchKind(filePath);
  if (!kind) return { kind: null, ms: 0, ok: false, lines: [`✖ Not a scratch file: ${filePath}`] };
  let source = opts.source;
  if (source === undefined) {
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      source = '';
    }
  }
  try {
    const cwd = opts.cwd || path.dirname(filePath);
    const env = opts.env || process.env;
    const org = opts.targetOrg !== undefined ? opts.targetOrg : readTargetOrg(cwd, os.homedir(), fs.readFileSync, env);
    const handle = startSf(sfArgsFor(kind, fileArgFor(cwd, filePath), org), {
      cwd,
      timeoutMs: opts.timeoutMs,
      env,
      sfPath: opts.sfPath,
    });
    if (typeof opts.onStart === 'function') {
      try {
        opts.onStart(handle);
      } catch (err) {
        // observer errors must not break the run
      }
    }
    const proc = await handle.done;
    const formatted = formatRun(kind, proc, source, opts);
    return { kind, org, ms: Date.now() - started, proc, ...formatted };
  } catch (err) {
    return { kind, ms: Date.now() - started, ok: false, lines: [`✖ ${err && err.message ? err.message : err}`] };
  }
}

module.exports = {
  SCRATCH_SEGMENTS,
  SCRATCH_FILE,
  KINDS,
  MAX_TABLE_ROWS,
  MAX_TIMEOUT_MS,
  DEBUG_BUDGET_CHARS,
  scratchDir,
  samePath,
  scratchKind,
  isScratchFile,
  nextScratchNumber,
  scratchFileName,
  OWNER_FILE,
  PARKED_MAX_AGE_MS,
  ownerFileName,
  isProcessAlive,
  hostIdentity,
  sameWindow,
  sessionOver,
  readOwnerFile,
  readOwners,
  ownerRole,
  ownersOf,
  claimedNames,
  writeClaims,
  touchClaims,
  removeDirIfEmpty,
  RUN_DIR,
  writeRunFile,
  removeRunFile,
  sweepRunDirs,
  fitOutput,
  initialContent,
  toLf,
  readTargetOrg,
  findExecutable,
  quoteCmdArg,
  quoteCmdCommand,
  buildCmdLine,
  sfSpawnSpec,
  startSf,
  runSf,
  stripAnsi,
  parseSfJson,
  interpretApexJson,
  interpretSoqlJson,
  parseLogEvents,
  parseApexLog,
  graphemes,
  textWidth,
  truncate,
  clock,
  formatDuration,
  formatHeader,
  sourceSnippet,
  formatDebugs,
  formatLimits,
  anonymousFrame,
  formatApexOutcome,
  splitSelect,
  soqlColumnHints,
  flattenRecords,
  renderTable,
  soqlErrorPosition,
  formatSoqlOutcome,
  sfArgsFor,
  fileArgFor,
  formatRun,
  runScratch,
};
