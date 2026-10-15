'use strict';

// node test/scratch.test.js                      unit tests (the org tests skip themselves)
// VIRGA_TEST_ORG=<alias> node test/scratch.test.js  also the integration tests against that org
// SKIP_ORG=1                                     never the org tests
// ONLY=<regex>                                   just the tests whose name matches
//
// Unit tests run the formatters on sf output recorded from a Developer Edition
// org (test/fixtures; record ids, the org alias and e-mail domains replaced by
// synthetic ones of the same length). The integration part writes scratch
// files into a throwaway SFDX project under .it-project/ and runs them through
// lib.runScratch, the same function the extension calls. It only queries and
// System.debugs. It needs an org you authorized with `sf org login` and runs
// only when VIRGA_TEST_ORG names it and sf answers for it; otherwise the org
// tests are reported as skipped.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const lib = require('../src/scratch/lib');

const FIX = path.join(ROOT, 'test', 'fixtures');
const IS_WIN = process.platform === 'win32';
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const fixtureProc = (name, code = 0) => ({ code, stdout: fixture(`${name}.json`), stderr: '' });
const fixtureSource = (name, ext) => (fs.existsSync(path.join(FIX, `${name}.${ext}`)) ? fixture(`${name}.${ext}`) : '');

const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });
const samples = [];

// ---------------------------------------------------------------------------
// scratch paths
// ---------------------------------------------------------------------------

test('scratchDir is <root>/.sfdx/virga-scratch', () => {
  assert.equal(lib.scratchDir(path.join('C:', 'proj')), path.join('C:', 'proj', '.sfdx', 'virga-scratch'));
});

test('isScratchFile accepts only scratch-N.apex|soql directly in the folder', () => {
  const root = path.resolve(os.tmpdir(), 'proj x');
  const dir = lib.scratchDir(root);
  assert.equal(lib.isScratchFile(path.join(dir, 'scratch-1.apex'), dir), true);
  assert.equal(lib.isScratchFile(path.join(dir, 'scratch-12.soql'), dir), true);
  assert.equal(lib.isScratchFile(path.join(dir, 'other.apex'), dir), false);
  assert.equal(lib.isScratchFile(path.join(dir, 'scratch-1.cls'), dir), false);
  assert.equal(lib.isScratchFile(path.join(dir, 'scratch-.apex'), dir), false);
  assert.equal(lib.isScratchFile(path.join(dir, 'sub', 'scratch-1.apex'), dir), false);
  assert.equal(lib.isScratchFile(path.join(root, 'force-app', 'scratch-1.apex'), dir), false);
  assert.equal(lib.isScratchFile(path.join(root, 'scratch-1.apex'), dir), false);
  assert.equal(lib.isScratchFile(path.join(dir, '..', 'scratch-1.apex'), dir), false);
  assert.equal(lib.isScratchFile(path.join(dir, 'x', '..', 'scratch-2.apex'), dir), true, 'normalized path inside');
  assert.equal(lib.isScratchFile('', dir), false);
  assert.equal(lib.isScratchFile(path.join(dir, 'scratch-1.apex'), ''), false);
});

test('isScratchFile is case-insensitive on Windows only', () => {
  const dir = path.resolve('/Proj/.sfdx/virga-scratch');
  const upper = path.join(dir.toUpperCase(), 'SCRATCH-1.APEX');
  assert.equal(lib.isScratchFile(upper, dir, 'win32'), true);
  assert.equal(lib.isScratchFile(upper, dir, 'linux'), dir.toUpperCase() === dir);
});

test('scratchKind', () => {
  assert.equal(lib.scratchKind('/a/scratch-3.apex'), 'apex');
  assert.equal(lib.scratchKind(path.join(path.resolve('a'), 'scratch-3.SOQL')), 'soql');
  assert.equal(lib.scratchKind('/a/notes.apex'), null);
});

test('nextScratchNumber counts per kind and never goes below the session counter', () => {
  const names = ['scratch-1.apex', 'scratch-4.apex', 'scratch-2.soql', 'readme.txt', 'scratch-9.cls'];
  assert.equal(lib.nextScratchNumber('apex', names), 5);
  assert.equal(lib.nextScratchNumber('soql', names), 3);
  assert.equal(lib.nextScratchNumber('soql', [], 0), 1);
  assert.equal(lib.nextScratchNumber('apex', ['scratch-1.apex'], 7), 8);
  assert.equal(lib.scratchFileName('apex', 2), 'scratch-2.apex');
  assert.equal(lib.scratchFileName('soql', 1), 'scratch-1.soql');
});

test('initialContent: Apex hint comment, empty line, cursor below; SOQL selects the field list', () => {
  const a = lib.initialContent('apex', 'devSandbox');
  assert.equal(a.text, '// Ctrl+S runs this in devSandbox. Close the tab to discard.\n\n');
  assert.deepEqual(a.selection, [2, 0, 2, 0]);
  assert.equal(lib.initialContent('apex', null).text.split('\n')[0], '// Ctrl+S runs this in the default org. Close the tab to discard.');
  const s = lib.initialContent('soql', 'x');
  assert.equal(s.text, 'SELECT Id, Name FROM Account LIMIT 10\n');
  assert.equal(s.text.split('\n')[0].slice(s.selection[1], s.selection[3]), 'Id, Name');
  assert.ok(!a.text.includes('\r') && !s.text.includes('\r'));
  assert.equal(lib.toLf('a\r\nb\rc\n'), 'a\nb\nc\n');
});

test('readTargetOrg: project .sf first, then legacy .sfdx, then global', () => {
  const files = {};
  const read = (f) => {
    if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[f];
  };
  const root = path.resolve('/p');
  const home = path.resolve('/h');
  const env = {};
  assert.equal(lib.readTargetOrg(root, home, read, env), null);
  files[path.join(home, '.sf', 'config.json')] = '{"target-org":"globalOrg"}';
  assert.equal(lib.readTargetOrg(root, home, read, env), 'globalOrg');
  files[path.join(root, '.sfdx', 'sfdx-config.json')] = '{"defaultusername":"legacy"}';
  assert.equal(lib.readTargetOrg(root, home, read, env), 'legacy');
  files[path.join(root, '.sf', 'config.json')] = '\uFEFF{\n  "target-org": "devSandbox"\n}';
  assert.equal(lib.readTargetOrg(root, home, read, env), 'devSandbox');
  files[path.join(root, '.sf', 'config.json')] = '{broken';
  assert.equal(lib.readTargetOrg(root, home, read, env), 'legacy');
});

test('readTargetOrg: SF_TARGET_ORG / SFDX_DEFAULTUSERNAME win over config, like in sf', () => {
  const root = path.resolve('/p');
  const read = (f) => {
    if (f === path.join(root, '.sf', 'config.json')) return '{"target-org":"devSandbox"}';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(lib.readTargetOrg(root, null, read, { SFDX_DEFAULTUSERNAME: 'legacyEnv' }), 'legacyEnv');
  assert.equal(lib.readTargetOrg(root, null, read, { sf_target_org: 'envOrg', SFDX_DEFAULTUSERNAME: 'legacyEnv' }), 'envOrg', 'any case, SF_ first');
  assert.equal(lib.readTargetOrg(root, null, read, { SF_TARGET_ORG: '  ' }), 'devSandbox', 'blank env ignored');
});

// ---------------------------------------------------------------------------
// finding and spawning sf
// ---------------------------------------------------------------------------

test('findExecutable walks PATH x PATHEXT like cmd.exe (Path key in any case)', () => {
  const env = { Path: 'C:\\a;"C:\\b c";C:\\d', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const present = new Set(['C:\\b c\\sf.CMD', 'C:\\d\\sf.EXE']);
  assert.equal(lib.findExecutable('sf', { env, platform: 'win32', exists: (p) => present.has(p) }), 'C:\\b c\\sf.CMD');
  present.add('C:\\b c\\sf.EXE');
  assert.equal(lib.findExecutable('sf', { env, platform: 'win32', exists: (p) => present.has(p) }), 'C:\\b c\\sf.EXE');
  assert.equal(lib.findExecutable('sf', { env: { PATH: '' }, platform: 'win32', exists: () => true }), null);
  assert.equal(lib.findExecutable('sf', { env: { PATH: '/usr/bin:/opt/sf/bin' }, platform: 'linux', exists: (p) => p === '/opt/sf/bin/sf' }), '/opt/sf/bin/sf');
});

test('quoteCmdArg leaves safe tokens alone and escapes everything cmd.exe would interpret', () => {
  assert.equal(lib.quoteCmdArg('--json'), '--json');
  assert.equal(lib.quoteCmdArg('.sfdx\\virga-scratch\\scratch-1.apex'), '.sfdx\\virga-scratch\\scratch-1.apex');
  assert.equal(lib.quoteCmdArg('a b'), '^"a^ b^"');
  assert.equal(lib.quoteCmdArg('a b', true), '^^^"a^^^ b^^^"');
  assert.equal(lib.quoteCmdArg('50%&x'), '^"50^%^&x^"');
  assert.equal(lib.quoteCmdArg('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(lib.quoteCmdArg('C:\\dir\\'), 'C:\\dir\\', 'unquoted trailing backslash is literal');
  assert.equal(lib.quoteCmdArg('C:\\my dir\\'), '^"C:\\my^ dir\\\\^"');
  assert.equal(lib.quoteCmdArg(''), '^"^"');
  assert.equal(lib.quoteCmdCommand('C:\\Program Files\\sf\\bin\\sf.cmd'), 'C:\\Program^ Files\\sf\\bin\\sf.cmd');
  assert.equal(lib.quoteCmdCommand('C:\\tools\\eq=dir\\sf.cmd'), 'C:\\tools\\eq^=dir\\sf.cmd', '= splits the command token in cmd.exe');
});

test('sfSpawnSpec: npm-installed sf runs node + run.js directly; other .cmd via cmd.exe; .exe and POSIX direct', () => {
  const none = { exists: () => false };
  const win = lib.sfSpawnSpec('C:\\Program Files\\sf\\bin\\sf.cmd', ['apex', 'run', '--file', 'a b.apex', '--json'], 'win32', none);
  assert.equal(win.shell, true);
  assert.equal(win.command, 'C:\\Program^ Files\\sf\\bin\\sf.cmd apex run --file ^^^"a^^^ b.apex^^^" --json');
  assert.deepEqual(lib.sfSpawnSpec('C:\\x\\sf.exe', ['a'], 'win32', none), { shell: false, command: 'C:\\x\\sf.exe', args: ['a'] });
  assert.deepEqual(lib.sfSpawnSpec('/usr/bin/sf', ['a'], 'linux', none), { shell: false, command: '/usr/bin/sf', args: ['a'] });
  // npm cmd-shim layout (npm i -g, fnm, nvm): <dir>\sf.cmd + <dir>\node_modules\@salesforce\cli\bin\run.js
  const dir = 'C:\\Users\\me\\AppData\\Roaming\\fnm\\node-versions\\v22.14.0\\installation';
  const runJs = `${dir}\\node_modules\\@salesforce\\cli\\bin\\run.js`;
  const withNode = lib.sfSpawnSpec(`${dir}\\sf.CMD`, ['data', 'query', '--json'], 'win32', { exists: (p) => p === runJs || p === `${dir}\\node.exe` });
  assert.deepEqual(withNode, { shell: false, command: `${dir}\\node.exe`, args: ['--no-deprecation', runJs, 'data', 'query', '--json'] });
  const pathNode = lib.sfSpawnSpec(`${dir}\\sf.cmd`, ['x'], 'win32', { env: { PATH: 'C:\\nodejs', PATHEXT: '.EXE' }, exists: (p) => p === runJs || p === 'C:\\nodejs\\node.EXE' });
  assert.deepEqual(pathNode, { shell: false, command: 'C:\\nodejs\\node.EXE', args: ['--no-deprecation', runJs, 'x'] });
  const noNode = lib.sfSpawnSpec(`${dir}\\sf.cmd`, ['x'], 'win32', { env: { PATH: '' }, exists: (p) => p === runJs });
  assert.equal(noNode.shell, true, 'no node.exe anywhere: back to cmd.exe');
});

test('sfArgsFor / fileArgFor: file path, never the script text; relative under cwd; --target-org when known', () => {
  assert.deepEqual(lib.sfArgsFor('apex', 'x.apex'), ['apex', 'run', '--file', 'x.apex', '--json']);
  assert.deepEqual(lib.sfArgsFor('soql', 'x.soql'), ['data', 'query', '--file', 'x.soql', '--json']);
  assert.deepEqual(lib.sfArgsFor('apex', 'x.apex', 'devSandbox'), ['apex', 'run', '--file', 'x.apex', '--target-org', 'devSandbox', '--json']);
  assert.deepEqual(lib.sfArgsFor('soql', 'x.soql', null), ['data', 'query', '--file', 'x.soql', '--json']);
  const root = path.resolve('/w/my proj & co');
  assert.equal(lib.fileArgFor(root, path.join(lib.scratchDir(root), 'scratch-1.apex')), path.join('.sfdx', 'virga-scratch', 'scratch-1.apex'));
  const outside = path.resolve('/elsewhere/scratch-1.apex');
  assert.equal(lib.fileArgFor(root, outside), outside);
  const unc = '\\\\server\\share\\proj';
  const uncFile = `${unc}\\.sfdx\\virga-scratch\\scratch-1.soql`;
  assert.equal(lib.fileArgFor(unc, uncFile), uncFile, 'absolute under a UNC cwd');
});

// Real processes: a fake sf.cmd in a folder whose name has spaces, &, %, ( and !.
const SHIM_DIR = path.join(ROOT, '.dev-cache', 'shim dir & 100% (x)!');
function writeShim(name, js, dir = SHIM_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.js`);
  fs.writeFileSync(script, js);
  const node = process.execPath;
  if (IS_WIN) {
    const cmd = path.join(dir, `${name}.cmd`);
    // Same shape as npm's cmd-shim: forwards %* to node.
    fs.writeFileSync(cmd, `@ECHO off\r\nSETLOCAL\r\n"${node}" "%~dp0\\${name}.js" %*\r\n`);
    return cmd;
  }
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

const ECHO_ARGS_JS = 'process.stdout.write(JSON.stringify({ status: 0, result: { argv: process.argv.slice(2), cwd: process.cwd(), env: process.env.SF_JSON_TO_STDOUT } }));';

/** npm's layout: <dir>\sf.cmd next to node_modules\@salesforce\cli\bin\run.js (node from PATH). */
function writeNpmLayout(dir) {
  const bin = path.join(dir, 'node_modules', '@salesforce', 'cli', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'run.js'), ECHO_ARGS_JS);
  const cmd = path.join(dir, 'sf.cmd');
  fs.writeFileSync(cmd, '@ECHO off\r\nnode "%~dp0\\node_modules\\@salesforce\\cli\\bin\\run.js" %*\r\n');
  return cmd;
}

const TRICKY_ARGS = ['apex', 'run', '--file', 'C:\\dir with space\\a&b (1)\\100%\\x!y^z=1;2,3.apex', 'quote"inside', 'trailing\\', '%PATH%', '--target-org', 'my org&co', '--json'];

test('startSf passes tricky arguments through cmd.exe and a .cmd shim unchanged', async () => {
  const shim = writeShim('echo-args', ECHO_ARGS_JS);
  const res = await lib.runSf(TRICKY_ARGS, { sfPath: shim, cwd: SHIM_DIR, timeoutMs: 20000 });
  assert.equal(res.code, 0, res.stderr);
  if (IS_WIN) assert.equal(res.spec.shell, true, 'not npm layout: cmd.exe');
  const json = lib.parseSfJson(res.stdout, res.stderr);
  assert.deepEqual(json.result.argv, TRICKY_ARGS);
  assert.equal(lib.samePath(json.result.cwd, SHIM_DIR), true);
  assert.equal(json.result.env, 'true');
});

// The README's Privacy section relies on SF_DISABLE_TELEMETRY: sf reports command usage unless it is off.
test('startSf: sf gets JSON on stdout, no update check, no colors and its telemetry off, whatever the caller has', async () => {
  const keys = ['SF_JSON_TO_STDOUT', 'SF_SKIP_NEW_VERSION_CHECK', 'SF_DISABLE_AUTOUPDATE', 'SF_AUTOUPDATE_DISABLE', 'SF_DISABLE_TELEMETRY', 'FORCE_COLOR'];
  const shim = writeShim('echo-env', `process.stdout.write(JSON.stringify({ status: 0, result: Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k]])) }));`);
  const env = { ...process.env, SF_DISABLE_TELEMETRY: 'false', SF_JSON_TO_STDOUT: 'false', FORCE_COLOR: '3' };
  const res = await lib.runSf(['org', 'display'], { sfPath: shim, cwd: SHIM_DIR, timeoutMs: 20000, env });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(lib.parseSfJson(res.stdout, res.stderr).result, {
    SF_JSON_TO_STDOUT: 'true',
    SF_SKIP_NEW_VERSION_CHECK: 'true',
    SF_DISABLE_AUTOUPDATE: 'true',
    SF_AUTOUPDATE_DISABLE: 'true',
    SF_DISABLE_TELEMETRY: 'true',
    FORCE_COLOR: '0',
  });
  assert.equal(env.SF_DISABLE_TELEMETRY, 'false', "the caller's environment object is left as it was");
});

test('startSf reaches sf.cmd in a folder whose name has = ; , ^ % (cmd.exe fallback)', async () => {
  for (const name of ['eq=dir', 'semi;colon,comma', 'caret^pct%OS%']) {
    const shim = writeShim('sf', ECHO_ARGS_JS, path.join(ROOT, '.dev-cache', 'odd', name));
    const res = await lib.runSf(TRICKY_ARGS, { sfPath: shim, cwd: SHIM_DIR, timeoutMs: 20000 });
    assert.equal(res.code, 0, `${name}: ${res.stderr}`);
    assert.deepEqual(lib.parseSfJson(res.stdout, res.stderr).result.argv, TRICKY_ARGS, name);
  }
}, { windowsOnly: true });

test('startSf: npm-installed sf runs without cmd.exe, arguments untouched', async () => {
  const shim = writeNpmLayout(path.join(ROOT, '.dev-cache', 'npm layout & 100% (x)! a=b'));
  const res = await lib.runSf(TRICKY_ARGS, { sfPath: shim, cwd: SHIM_DIR, timeoutMs: 20000 });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.spec.shell, false);
  assert.match(res.spec.command, /node(\.exe)?$/i);
  assert.deepEqual(lib.parseSfJson(res.stdout, res.stderr).result.argv, TRICKY_ARGS);
}, { windowsOnly: true });

test('startSf: UNC working directory works with npm-installed sf (cmd.exe would refuse it)', async () => {
  const shim = writeNpmLayout(path.join(ROOT, '.dev-cache', 'npm layout & 100% (x)! a=b'));
  const local = path.join(ROOT, '.dev-cache');
  const unc = `\\\\localhost\\${local[0]}$${local.slice(2)}`;
  if (!fs.existsSync(unc)) return `skipped: ${unc} not reachable (admin share off)`;
  const res = await lib.runSf(['x'], { sfPath: shim, cwd: unc, timeoutMs: 20000 });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!/UNC paths are not supported/i.test(res.stderr), res.stderr);
  assert.equal(lib.parseSfJson(res.stdout, res.stderr).result.cwd.toLowerCase(), unc.toLowerCase());
  return undefined;
}, { windowsOnly: true });

test('startSf times out and kills the whole process tree', async () => {
  const shim = writeShim('sleeper', 'setTimeout(() => process.stdout.write("late"), 30000);');
  const t0 = Date.now();
  const res = await lib.runSf(['x'], { sfPath: shim, timeoutMs: 1500 });
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  assert.equal(res.stdout, '');
});

test('startSf: a huge timeout (virga.scratch.timeoutSeconds = 3000000) does not overflow setTimeout', async () => {
  const shim = writeShim('slow', 'setTimeout(() => process.stdout.write(JSON.stringify({ status: 0, result: { records: [], totalSize: 0, done: true } })), 1200);');
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  try {
    const res = await lib.runSf(['data', 'query'], { sfPath: shim, timeoutMs: 3000000 * 1000 });
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 0);
  } finally {
    process.off('warning', onWarning);
  }
  assert.ok(!warnings.includes('TimeoutOverflowWarning'), warnings.join());
  assert.equal(lib.MAX_TIMEOUT_MS, 2147483647);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.configuration.properties['virga.scratch.timeoutSeconds'].maximum, 86400);
});

test('startSf: sf missing from PATH -> notFound, formatted as a hint', async () => {
  const res = await lib.runSf(['--version'], { env: { PATH: path.join(SHIM_DIR, 'nope'), PATHEXT: '.CMD' } });
  assert.equal(res.notFound, true);
  const out = lib.formatRun('apex', res, '', {});
  assert.match(out.lines[0], /^✖ Salesforce CLI \(sf\) not found on PATH/);
});

test('startSf kill() stops a running sf', async () => {
  const shim = writeShim('sleeper2', 'setTimeout(() => {}, 30000);');
  const handle = lib.startSf(['x'], { sfPath: shim, timeoutMs: 60000 });
  setTimeout(() => handle.kill(), 800);
  const t0 = Date.now();
  const res = await handle.done;
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(res.killed, true);
});

// No console window may flash on the user's screen during a run: sf (through
// cmd.exe or node directly) and taskkill all start with windowsHide.
test('every process the extension starts has windowsHide: sf direct, sf through cmd.exe, taskkill', async () => {
  const { EventEmitter } = require('events');
  const cp = require('child_process');
  const fakeChild = () => Object.assign(new EventEmitter(), { pid: 999999, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  const sfCalls = [];
  const children = [];
  const spawn = (...args) => {
    sfCalls.push(args);
    const c = fakeChild();
    children.push(c);
    return c;
  };
  const killCalls = [];
  const realSpawn = cp.spawn;
  cp.spawn = (...args) => {
    killCalls.push(args);
    return fakeChild();
  };
  try {
    for (const sfPath of ['C:\\no-such\\sf.cmd', 'C:\\no-such\\sf.exe']) {
      const h = lib.startSf(['apex', 'run', '--json'], { sfPath, spawn, platform: 'win32', env: { PATH: '' }, timeoutMs: 60000 });
      h.kill(); // -> taskkill /T /F, never a real process: cp.spawn is the recorder here
      children[children.length - 1].emit('close', 1); // the stand-in ends, which clears the run's timeout
      const res = await h.done;
      assert.equal(res.killed, true);
    }
  } finally {
    cp.spawn = realSpawn;
  }
  assert.equal(sfCalls.length, 2);
  const options = sfCalls.map((args) => args[args.length - 1]);
  assert.deepEqual(options.map((o) => [o.shell, o.windowsHide]), [[true, true], [false, true]], 'cmd.exe and direct');
  assert.equal(killCalls.length, 2);
  for (const [cmd, , o] of killCalls) {
    assert.equal(cmd, 'taskkill');
    assert.equal(o.windowsHide, true);
  }
  // Nothing else starts processes: extension.js has no child_process at all, lib.js only these two spawns.
  const ext = fs.readFileSync(path.join(ROOT, 'src', 'scratch', 'extension.js'), 'utf8');
  assert.ok(!/child_process/.test(ext));
  const src = fs.readFileSync(path.join(ROOT, 'src', 'scratch', 'lib.js'), 'utf8');
  assert.deepEqual(src.match(/childProcess\.\w+/g), ['childProcess.spawn', 'childProcess.spawn'], 'taskkill and the default spawnFn');
});

// ---------------------------------------------------------------------------
// sf JSON
// ---------------------------------------------------------------------------

test('parseSfJson: plain, with noise around it, from stderr, garbage', () => {
  assert.deepEqual(lib.parseSfJson('{"status":0}', ''), { status: 0 });
  assert.deepEqual(lib.parseSfJson('\u001b[33mWarning: update available\u001b[0m\n{\n  "status": 1,\n  "name": "X"\n}\n', ''), { status: 1, name: 'X' });
  assert.deepEqual(lib.parseSfJson('', ' Warning: x\n{"status":1,"message":"m"}'), { status: 1, message: 'm' });
  assert.equal(lib.parseSfJson('not json', 'Error: boom'), null);
  assert.equal(lib.parseSfJson('', ''), null);
});

test('interpretApexJson: success / compile / exception (data under error body) / sf error', () => {
  const ok = lib.interpretApexJson(JSON.parse(fixture('apex-success.json')));
  assert.equal(ok.type, 'success');
  assert.ok(ok.logs.includes('USER_DEBUG'));
  const ce = lib.interpretApexJson(JSON.parse(fixture('apex-compile-error.json')));
  assert.deepEqual([ce.type, ce.line, ce.column, ce.problem], ['compile', 2, 1, 'Invalid type: Strin']);
  const ex = lib.interpretApexJson(JSON.parse(fixture('apex-exception.json')));
  assert.deepEqual([ex.type, ex.message, ex.stack, ex.line], ['exception', 'System.MathException: Divide by 0', 'AnonymousBlock: line 3, column 1', 3]);
  const err = lib.interpretApexJson(JSON.parse(fixture('sf-noorg.json')));
  assert.equal(err.type, 'error');
  assert.equal(err.name, 'NamedOrgNotFoundError');
  // Older sf: compile failures reported with status 0 under result.
  const legacy = lib.interpretApexJson({ status: 0, result: { compiled: false, success: false, compileProblem: 'p', line: 4, column: 2 } });
  assert.deepEqual([legacy.type, legacy.line], ['compile', 4]);
});

test('interpretSoqlJson: records / error code from data', () => {
  const r = lib.interpretSoqlJson(JSON.parse(fixture('soql-basic.json')));
  assert.deepEqual([r.type, r.totalSize, r.done, r.records.length], ['records', 3, true, 3]);
  const e = lib.interpretSoqlJson(JSON.parse(fixture('soql-malformed.json')));
  assert.deepEqual([e.type, e.code], ['error', 'MALFORMED_QUERY']);
});

// ---------------------------------------------------------------------------
// Apex log
// ---------------------------------------------------------------------------

test('parseApexLog: USER_DEBUG lines, levels, multi-line messages, limits', () => {
  const { logs } = lib.interpretApexJson(JSON.parse(fixture('apex-success.json')));
  const log = lib.parseApexLog(logs);
  assert.deepEqual(log.debugs.map((d) => [d.line, d.level]), [[3, 'DEBUG'], [5, 'WARN'], [6, 'DEBUG'], [8, 'DEBUG'], [9, 'DEBUG'], [10, 'ERROR'], [11, 'INFO']]);
  assert.equal(log.debugs[0].message, 'hello 42');
  assert.equal(log.debugs[2].message, 'multi\nline\nmsg');
  assert.deepEqual(log.limits['Number of SOQL queries'], { used: 1, max: 100 });
  assert.deepEqual(log.limits['Number of query rows'], { used: 3, max: 50000 });
  assert.deepEqual(log.limits['Maximum CPU time'], { used: 0, max: 10000 });
  const inner = lib.parseApexLog(lib.interpretApexJson(JSON.parse(fixture('apex-exception-inner.json'))).logs);
  assert.equal(inner.debugs[1].message, '{\n  "b" : "two",\n  "a" : 1\n}');
});

test('parseApexLog: last (default) namespace block wins, managed namespaces ignored, odd markers', () => {
  const logs = [
    '12:00:00.1 (1)|USER_DEBUG|[EXTERNAL]|INFO|from trigger',
    '12:00:00.1 (2)|LIMIT_USAGE_FOR_NS|(default)|',
    '  Number of SOQL queries: 1 out of 100',
    '12:00:00.1 (3)|LIMIT_USAGE_FOR_NS|pse|',
    '  Number of SOQL queries: 50 out of 100',
    '12:00:00.1 (4)|LIMIT_USAGE_FOR_NS|(default)|',
    '  Number of SOQL queries: 7 out of 100',
    '  Maximum CPU time: 12 out of 10000 ******* CLOSE TO LIMIT',
    '',
  ].join('\n');
  const log = lib.parseApexLog(logs);
  assert.deepEqual(log.debugs, [{ line: null, level: 'INFO', message: 'from trigger' }]);
  assert.deepEqual(log.limits['Number of SOQL queries'], { used: 7, max: 100 });
  assert.deepEqual(log.limits['Maximum CPU time'], { used: 12, max: 10000 });
  assert.deepEqual(lib.parseApexLog(''), { debugs: [], limits: null });
});

test('parseApexLog: | in a debug message (logged as &#124;) comes back as |; other characters untouched', () => {
  const pipes = apexLines('apex-pipes');
  assert.ok(pipes.includes('  [line 4]  DEBUG  a|b|c'), pipes.join('\n'));
  assert.ok(pipes.includes('                   |DEBUG|x'), 'a continuation line that looks like log fields stays a continuation');
  assert.ok(pipes.includes('                   12:00:00.0 (1)|USER_DEBUG|[99]|DEBUG|injected'), 'an injected log line is not parsed as an event');
  assert.equal(pipes.filter((l) => /^ {2}\[line/.test(l)).length, 8);
  const entities = apexLines('apex-entities');
  assert.equal(entities[2], '  [line 1] DEBUG  a & b < c > d "q" \'s \\ back\ttab | pipe | literal');
  assert.equal(entities[3], '  [line 2] DEBUG  {"html":"<b>&amp;</b>","k|1":"v<2>"}');
  assert.ok(!pipes.concat(entities).some((l) => l.includes('&#124;')));
});

test('formatDebugs: a huge debug section keeps its head and tail within the budget, with a note', () => {
  const debugs = Array.from({ length: 22000 }, (_, i) => ({ line: 4, level: 'DEBUG', message: `${i}${'x'.repeat(90)}` }));
  const lines = lib.formatDebugs(debugs);
  const size = lines.reduce((n, l) => n + l.length + 1, 0);
  assert.ok(size <= lib.DEBUG_BUDGET_CHARS, `${size}`);
  assert.equal(lines[0], `  [line 4] DEBUG  0${'x'.repeat(90)}`);
  assert.equal(lines[lines.length - 1], `  [line 4] DEBUG  21999${'x'.repeat(90)}`);
  const note = lines.findIndex((l) => /^ {2}… \d+ of 22000 debug messages omitted \(output limit\)$/.test(l));
  assert.ok(note > 0, 'omission note between head and tail');
  const omitted = Number(/… (\d+) of/.exec(lines[note])[1]);
  assert.equal(lines.length - 1 + omitted, 22000);
  // one giant message is cut, not dropped
  const one = lib.formatDebugs([{ line: 1, level: 'DEBUG', message: 'y'.repeat(300000) }]);
  assert.equal(one.length, 1);
  assert.match(one[0], /… \(200000 more characters\)$/);
  // small output unchanged
  assert.deepEqual(lib.formatDebugs([{ line: 2, level: 'INFO', message: 'a\nb' }]), ['  [line 2] INFO   a', '                  b']);
});

test('formatApexOutcome: an exception after huge debug output still leads the output', () => {
  const logs = [];
  for (let i = 0; i < 22000; i += 1) logs.push(`12:00:00.1 (${i})|USER_DEBUG|[4]|DEBUG|${i}${'x'.repeat(90)}`);
  logs.push('12:00:00.1 (9)|LIMIT_USAGE_FOR_NS|(default)|', '  Number of SOQL queries: 0 out of 100');
  const out = lib.formatApexOutcome({ type: 'exception', message: 'System.MathException: Divide by 0', stack: 'AnonymousBlock: line 6, column 1', logs: logs.join('\n'), line: 6, column: 1, warnings: [] }, 'a\nb\nc\nd\ne\nInteger y = 1 / z;\n');
  assert.equal(out[0], '✔ Compiled  ✖ Exception: System.MathException: Divide by 0');
  assert.ok(out.includes('  6 │ Integer y = 1 / z;'));
  assert.match(out[out.length - 1], /^ {2}Limits {2}SOQL queries 0\/100/);
  assert.ok(out.join('\n').length < 2000000);
});

test('fitOutput: never keeps only the tail; drops whole earlier runs; cuts an oversized block at a line', () => {
  const run = (n, size) => `▶ Apex · devSandbox · 20:00:0${n} · 1 s\n✔ Compiled  ✔ Executed\n${'d'.repeat(size)}\n`;
  assert.equal(lib.fitOutput('', 'abc\n', 100), 'abc\n');
  const big = `${run(1, 10)}${'  [line 1] DEBUG  x\n'.repeat(200)}`;
  const cut = lib.fitOutput('', big, 1000);
  assert.ok(cut.length <= 1000);
  assert.ok(cut.startsWith('▶ Apex · devSandbox · 20:00:01 · 1 s\n✔ Compiled  ✔ Executed\n'));
  assert.match(cut, /\n… output cut at 1000 characters\n$/);
  const cutLines = cut.split('\n');
  assert.equal(cutLines[cutLines.indexOf('… output cut at 1000 characters') - 1], '  [line 1] DEBUG  x', 'cut at a line boundary');
  const kept = lib.fitOutput(`${run(1, 400)}\n${run(2, 400)}\n`, run(3, 400), 1000);
  assert.ok(kept.length <= 1000);
  assert.ok(kept.startsWith('▶ Apex · devSandbox · 20:00:02'), kept.slice(0, 60));
  assert.ok(kept.includes('20:00:03'));
  assert.equal(lib.fitOutput(run(1, 900), run(2, 50), 1000).startsWith('▶ Apex · devSandbox · 20:00:02'), true, 'older run dropped entirely when it does not fit');
});

test('formatLimits: two lines, extra non-zero limits appended', () => {
  const lines = lib.formatLimits({
    'Number of SOQL queries': { used: 1, max: 100 },
    'Number of query rows': { used: 3, max: 50000 },
    'Number of DML statements': { used: 0, max: 150 },
    'Number of DML rows': { used: 0, max: 10000 },
    'Maximum CPU time': { used: 4, max: 10000 },
    'Maximum heap size': { used: 0, max: 6000000 },
    'Number of callouts': { used: 2, max: 100 },
    'Number of future calls': { used: 0, max: 50 },
  });
  assert.deepEqual(lines, [
    '  Limits  SOQL queries 1/100 · query rows 3/50000 · DML statements 0/150 · DML rows 0/10000',
    '          CPU time 4/10000 ms · heap 0/6000000 bytes · callouts 2/100',
  ]);
  assert.deepEqual(lib.formatLimits(null), []);
});

// ---------------------------------------------------------------------------
// Apex output
// ---------------------------------------------------------------------------

function apexLines(name, code = 0) {
  return lib.formatRun('apex', fixtureProc(name, code), fixtureSource(name, 'apex'), {}).lines;
}

test('Apex success: status, aligned debug lines with indented continuation, limits', () => {
  const lines = apexLines('apex-success');
  assert.equal(lines[0], '✔ Compiled  ✔ Executed');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '  [line 3]  DEBUG  hello 42');
  assert.equal(lines[3], '  [line 5]  WARN   3');
  assert.equal(lines[4], '  [line 6]  DEBUG  multi');
  assert.equal(lines[5], '                   line');
  assert.equal(lines[6], '                   msg');
  assert.equal(lines[7], '  [line 8]  DEBUG  {b=true, k=null, n=5}');
  assert.ok(lines.includes('  [line 10] ERROR  err level'));
  assert.ok(lines.some((l) => l.startsWith('  Limits  SOQL queries 1/100 · query rows 3/50000')));
  assert.ok(lines.some((l) => l === '          CPU time 0/10000 ms · heap 0/10000000 bytes'));
});

test('Apex success without System.debug says so', () => {
  const lines = apexLines('apex-nodebug');
  assert.deepEqual(lines.slice(0, 3), ['✔ Compiled  ✔ Executed', '', '  (no debug output)']);
});

test('Apex compile error: message, offending line, caret under the column', () => {
  assert.deepEqual(apexLines('apex-compile-error', 1), [
    '✖ Compile error line 2, column 1: Invalid type: Strin',
    '',
    "  2 │ Strin y = 'a';",
    '    │ ^',
  ]);
  const src = 'Integer a = 1;\n\tString s = nope;\n';
  const out = lib.formatApexOutcome({ type: 'compile', problem: 'Variable does not exist: nope', line: 2, column: 13, logs: '', warnings: [] }, src);
  assert.deepEqual(out.slice(2), ['  2 │ \tString s = nope;', '    │ \t           ^']);
});

test('Apex runtime exception: message, stack, source line, debug before failure, limits', () => {
  const lines = apexLines('apex-exception', 1);
  assert.deepEqual(lines.slice(0, 8), [
    '✔ Compiled  ✖ Exception: System.MathException: Divide by 0',
    '  at AnonymousBlock: line 3, column 1',
    '',
    '  3 │ Integer i = 1 / z;',
    '    │ ^',
    '',
    '  [line 1] DEBUG  before',
    '',
  ]);
  assert.match(lines[8], /^ {2}Limits {2}SOQL queries 0\/100/);
  const npe = apexLines('apex-npe', 1);
  assert.equal(npe[0], '✔ Compiled  ✖ Exception: System.NullPointerException: Attempt to de-reference a null object');
  assert.ok(npe.includes('  3 │ String s = acc.Name;'));
});

test('Apex exception in a class declared in the scratch points at its line; org classes do not', () => {
  const lines = apexLines('apex-exception-inner', 1);
  assert.deepEqual(lines.slice(0, 4), [
    '✔ Compiled  ✖ Exception: System.IllegalArgumentException: bad thing',
    '  at Class.Helper.boom: line 4, column 1',
    '  at AnonymousBlock: line 8, column 1',
    '',
  ]);
  assert.equal(lines[4], "  4 │         throw new IllegalArgumentException('bad thing');");
  assert.deepEqual(lib.anonymousFrame('Class.OrgService.run: line 40, column 1\nAnonymousBlock: line 2, column 1', 'OrgService.run();\nnew X();'), { line: 2, column: 1 });
  assert.equal(lib.anonymousFrame('Class.OrgService.run: line 40, column 1', 'x'), null);
});

test('sf error body (no org): name, message, suggested action', () => {
  assert.deepEqual(apexLines('sf-noorg', 2), [
    '✖ NamedOrgNotFoundError: Parsing --target-org',
    '  No authorization information found for doesNotExistAlias.',
    '  → It looks like you mistyped the username or alias. Did you mean "devSandbox"?',
  ]);
});

test('formatRun: non-JSON exit, timeout, spawn error, warnings', () => {
  const noJson = lib.formatRun('apex', { code: 1, stdout: '', stderr: '\u001b[31mError (1): something broke\u001b[0m\n   at x\n' }, '', {});
  assert.deepEqual(noJson.lines, ['✖ sf exited with code 1 without a JSON result', '  Error (1): something broke', '     at x']);
  assert.match(lib.formatRun('soql', { timedOut: true }, '', { timeoutMs: 5000 }).lines[0], /^✖ Timed out after 5 s/);
  assert.match(lib.formatRun('soql', { error: new Error('EPERM') }, '', {}).lines[0], /^✖ Could not start sf: EPERM/);
  const warned = lib.formatRun('apex', { code: 0, stdout: JSON.stringify({ status: 0, result: { compiled: true, success: true, logs: '' }, warnings: ['Heads up\nsecond line'] }) }, '', {});
  assert.deepEqual(warned.lines.slice(-2), ['', '⚠ Heads up second line']);
});

// ---------------------------------------------------------------------------
// SOQL output
// ---------------------------------------------------------------------------

function soqlLines(name, opts = {}) {
  return lib.formatRun('soql', fixtureProc(name), fixtureSource(name, 'soql'), { maxColumnWidth: 40, ...opts }).lines;
}

test('SOQL table: box borders, header, column widths from content', () => {
  assert.deepEqual(soqlLines('soql-basic'), [
    '✔ 3 records',
    '┌────────────────────┬─────────────────────────────────────┐',
    '│ Id                 │ Name                                │',
    '├────────────────────┼─────────────────────────────────────┤',
    '│ 001Dm0000AbC001AAA │ Edge Communications                 │',
    '│ 001Dm0000AbC002AAA │ Burlington Textiles Corp of America │',
    '│ 001Dm0000AbC003AAA │ Pyramid Construction Inc.           │',
    '└────────────────────┴─────────────────────────────────────┘',
  ]);
});

test('SOQL relationship fields are flattened to dotted names, attributes dropped', () => {
  const lines = soqlLines('soql-relationship');
  assert.equal(lines[2], '│ Id                 │ Name         │ Account.Name           │ Account.Owner.Name │ Email                 │');
  assert.equal(lines[4], '│ 003Dm0000AbC011AAA │ Andy Young   │ Dickenson plc          │ OrgFarm EPIC       │ a_young@exampleco.com │');
  assert.ok(!lines.join('\n').includes('attributes'));
});

test('SOQL subqueries become [n rows], null subquery [0 rows]', () => {
  const lines = soqlLines('soql-subquery');
  assert.equal(lines[2], '│ Id                 │ Name                                │ Contacts │ Cases    │');
  assert.equal(lines[5], '│ 001Dm0000AbC012AAA │ Dickenson plc                       │ [1 row]  │ [0 rows] │');
  assert.equal(lines[6], '│ 001Dm0000AbC001AAA │ Edge Communications                 │ [2 rows] │ [1 row]  │');
});

test('SOQL null, numbers right-aligned, booleans, long values truncated with an ellipsis', () => {
  const lines = soqlLines('soql-types');
  assert.equal(lines[4], '│ 001Dm0000AbC002AAA │ Burlington Textiles Corp of America │     350000000 │ false     │ 2026-10-07T21:25:17.000+0000 │ null                                     │');
  assert.ok(lines[6].endsWith('│ Edge, founded in 1998, is a start-up ba… │'));
  const narrow = soqlLines('soql-types', { maxColumnWidth: 10 });
  assert.ok(narrow[2].includes('│ AnnualRev… │'), narrow[2]);
  assert.ok(narrow[6].includes('│ Edge, fou… │'), narrow[6]);
  assert.ok(narrow.slice(1).every((l) => lib.textWidth(l) === lib.textWidth(narrow[1])), 'all table lines equally wide');
});

test('SOQL zero rows, COUNT(), aggregate aliases, null relationship, compound field', () => {
  assert.deepEqual(soqlLines('soql-zero'), ['✔ 0 records']);
  assert.deepEqual(soqlLines('soql-count'), ['✔ 13 records (count only)']);
  const agg = soqlLines('soql-aggregate');
  assert.equal(agg[2], '│ cnt │ Industry       │');
  assert.equal(agg[4], '│   2 │ null           │');
  const nullRel = soqlLines('soql-null-relationship');
  assert.equal(nullRel[2], '│ Id                 │ LastName │ Account.Name │', 'the selected dotted column, not "Account"');
  assert.equal(nullRel[4], '│ 003Dm0000AbC009AAA │ Hart     │ null         │');
  const compound = soqlLines('soql-compound', { maxColumnWidth: 200 });
  assert.ok(compound[4].includes('{city=Austin, country=United States, countryCode=US, state=TX, stateCode=TX, street=312 Constitution Place↵Austin, TX 78767↵USA}'));
});

test('flattenRecords: relationship null in early rows still gets dotted columns', () => {
  const records = [
    { attributes: { type: 'Contact' }, Id: '1', Account: null },
    { attributes: { type: 'Contact' }, Id: '2', Account: { attributes: { type: 'Account' }, Name: 'A', Owner: { attributes: {}, Name: 'O' } } },
    { attributes: { type: 'Contact' }, Id: '3', Account: { attributes: { type: 'Account' }, Name: 'B', Owner: null } },
  ];
  const { columns, rows } = lib.flattenRecords(records);
  assert.deepEqual(columns.map((c) => c.label), ['Id', 'Account.Name', 'Account.Owner.Name']);
  assert.deepEqual(rows.map((r) => r.map((c) => c.text)), [['1', 'null', 'null'], ['2', 'A', 'O'], ['3', 'B', 'null']]);
});

test('SOQL: subquery empty in every row is [0 rows]; relationship null in every row keeps its dotted columns', () => {
  const sub = soqlLines('soql-subquery-empty');
  assert.equal(sub[2], '│ Id                 │ Name                                │ Opportunities │');
  assert.ok(sub.slice(4, -1).every((l) => l.endsWith('│ [0 rows]      │')), sub.join('\n'));
  const nested = soqlLines('soql-null-nested');
  assert.equal(nested[2], '│ Id                 │ LastName  │ Account.Owner.Name │ ReportsTo.Name │ ReportsTo.Account.Name │');
  assert.equal(nested[4], '│ 003Dm0000AbC004AAA │ Forbes    │ OrgFarm EPIC       │ null           │ null                   │');
});

test('splitSelect / soqlColumnHints: top-level items only, strings, functions, TYPEOF, nested subqueries', () => {
  const q = "SELECT Id, toLabel(Status), Account.Owner.Name, (SELECT Id, (SELECT Id FROM Assets) FROM Contacts WHERE Name = 'a, (b) FROM x'), TYPEOF What WHEN Account THEN Phone, Name ELSE Id END, COUNT(Id) cnt FROM Account WHERE Name = 'x'";
  const sel = lib.splitSelect(q);
  assert.equal(sel.from, 'Account');
  assert.deepEqual(sel.items, ['Id', 'toLabel(Status)', 'Account.Owner.Name', "(SELECT Id, (SELECT Id FROM Assets) FROM Contacts WHERE Name = 'a, (b) FROM x')", 'TYPEOF What WHEN Account THEN Phone, Name ELSE Id END', 'COUNT(Id) cnt']);
  assert.deepEqual(lib.soqlColumnHints(q), [{ path: ['Account', 'Owner', 'Name'] }, { sub: 'Contacts' }]);
  assert.deepEqual(lib.soqlColumnHints('\n\n  select id,\n  reportsto.name\nfrom contact'), [{ path: ['reportsto', 'name'] }]);
  assert.deepEqual(lib.soqlColumnHints('not soql'), []);
  assert.equal(lib.splitSelect('SELECT Id'), null, 'no FROM');
  assert.equal(lib.splitSelect("SELECT Id, Name FROM Account WHERE Name = 'it\\'s, (x'").from, 'Account');
});

test('flattenRecords hints: query case vs API case, data wins over hints, aliases ignored', () => {
  const recs = [
    { attributes: {}, Id: '1', ReportsTo: null, Contacts: null, Industry: null },
    { attributes: {}, Id: '2', ReportsTo: null, Contacts: null, Industry: 'Banking' },
  ];
  const hints = lib.soqlColumnHints('SELECT Id, reportsto.Name, (SELECT Id FROM contacts), Industry.Foo FROM Contact');
  const { columns, rows } = lib.flattenRecords(recs, hints);
  assert.deepEqual(columns.map((c) => `${c.label}:${c.type}`), ['Id:value', 'ReportsTo.Name:value', 'Contacts:sub', 'Industry:value']);
  assert.deepEqual(rows[1].map((c) => c.text), ['2', 'null', '[0 rows]', 'Banking']);
  const agg = lib.flattenRecords([{ attributes: {}, an: 'Acme', expr0: 2 }], lib.soqlColumnHints('SELECT Account.Name an, COUNT(Id) FROM Opportunity GROUP BY Account.Name'));
  assert.deepEqual(agg.columns.map((c) => c.label), ['an', 'expr0']);
});

test('SOQL error caret: leading blank lines and indentation map onto the file', () => {
  assert.deepEqual(soqlLines('soql-error-indented').slice(2), ['  1 │     SELECT Id, Nme FROM Account', '    │                ^']);
  assert.match(soqlLines('soql-error-indented')[0], /^✖ INVALID_FIELD at row 1, column 16: /);
  assert.deepEqual(soqlLines('soql-error-leading-lines').slice(2), ['  4 │     Nme', '    │     ^']);
  assert.match(soqlLines('soql-error-leading-lines')[0], /^✖ INVALID_FIELD at row 4, column 5: /);
  assert.deepEqual(lib.soqlErrorPosition('SELECT x', 1, 8), { line: 1, column: 8 });
  assert.deepEqual(lib.soqlErrorPosition('\r\n\t SELECT x\r\n  FROM y', 1, 8), { line: 2, column: 10 });
  assert.deepEqual(lib.soqlErrorPosition('\r\n\t SELECT x\r\n  FROM y', 2, 3), { line: 3, column: 3 });
});

test('SOQL table: a wide result is capped by characters too, never overflowing the channel', () => {
  const records = Array.from({ length: 2000 }, (_, i) => {
    const r = { attributes: {} };
    for (let c = 0; c < 60; c += 1) r[`Field_${c}__c`] = `${i}-${'v'.repeat(45)}`;
    return r;
  });
  const out = lib.formatSoqlOutcome({ type: 'records', records, totalSize: 2000, done: true, warnings: [] }, '', { maxColumnWidth: 40 });
  const size = out.join('\n').length;
  assert.ok(size < 1600000, `${size}`);
  assert.match(out[out.length - 1], /^… \d+ more rows not shown$/);
  assert.equal(out[0], '✔ 2000 records');
});

test('SOQL done=false and partial fetch are reported', () => {
  const json = { status: 0, result: { done: false, totalSize: 5, records: [{ attributes: {}, Id: 'a' }, { attributes: {}, Id: 'b' }] } };
  const lines = lib.formatRun('soql', { code: 0, stdout: JSON.stringify(json) }, '', {}).lines;
  assert.equal(lines[0], '✔ 5 records (more available), showing 2');
  const one = { status: 0, result: { done: true, totalSize: 1, records: [{ attributes: {}, Id: 'a' }] } };
  assert.equal(lib.formatRun('soql', { code: 0, stdout: JSON.stringify(one) }, '', {}).lines[0], '✔ 1 record');
});

test('SOQL rows beyond the display cap are summarized', () => {
  const records = Array.from({ length: 5 }, (_, i) => ({ attributes: {}, N: i }));
  const out = lib.formatSoqlOutcome({ type: 'records', records, totalSize: 5, done: true, warnings: [] }, '', { maxRows: 3 });
  assert.equal(out[out.length - 1], '… 2 more rows not shown');
});

test('SOQL errors: code, row/column, description, the query line with a caret', () => {
  const invalid = soqlLines('soql-invalid-field');
  assert.match(invalid[0], /^✖ INVALID_FIELD at row 1, column 12: No such column 'Nme' on entity 'Account'\./);
  assert.deepEqual(invalid.slice(1), ['', '  1 │ SELECT Id, Nme FROM Account', '    │            ^']);
  assert.deepEqual(soqlLines('soql-malformed'), [
    "✖ MALFORMED_QUERY at row 1, column 23: unexpected token: '<EOF>'",
    '',
    '  1 │ SELECT Id FROM Account,',
    '    │                       ^',
  ]);
  const multi = soqlLines('soql-multiline-error');
  assert.deepEqual(multi.slice(2), ['  3 │   Nme', '    │   ^']);
  // Without the file text, sf's own snippet is used.
  const own = lib.formatRun('soql', fixtureProc('soql-malformed', 1), '', {}).lines;
  assert.deepEqual(own.slice(1), ['', '  SELECT Id FROM Account,', '                        ^']);
});

test('renderTable: wide characters keep borders aligned; control characters flattened', () => {
  const lines = lib.renderTable(['Name', 'Note'], [[{ text: '日本' }, { text: 'a↵b' }], [{ text: 'Zażółć' }, { text: 'x' }]], 40);
  const widths = lines.map((l) => lib.textWidth(l));
  assert.ok(widths.every((w) => w === widths[0]), JSON.stringify(widths));
  assert.equal(lib.truncate('日本語テキスト', 6), '日本…');
  assert.equal(lib.textWidth('日本…'), 5);
});

test('textWidth: emoji shown as emoji are 2 columns (East Asian Width W), text symbols 1', () => {
  for (const s of ['😀', '🚀', '✅', '⭐', '❌', '☕', '🟢', '🫠', '👍🏽', '👨\u{200D}👩\u{200D}👧', '🇵🇱', '❤\u{FE0F}']) assert.equal(lib.textWidth(s), 2, s);
  for (const s of ['✔', '✖', '▶', '©', '™', '↵', 'é', 'e\u{301}', 'ż', '❤']) assert.equal(lib.textWidth(s), 1, s);
  const lines = lib.renderTable(['Name'], [[{ text: 'Order shipped 🚀' }], [{ text: 'Order shipped 😀' }], [{ text: 'Order shipped ab' }], [{ text: 'Rodzina 👨\u{200D}👩\u{200D}👧 ok' }]], 40);
  const widths = lines.map((l) => lib.textWidth(l));
  assert.ok(widths.every((w) => w === widths[0]), JSON.stringify(widths));
  assert.equal(lib.truncate('ab👨\u{200D}👩\u{200D}👧cd', 4), 'ab…', 'a ZWJ family is never split');
});

test('header, clock and duration formats', () => {
  const d = new Date(2026, 9, 13, 20, 41, 3);
  assert.equal(lib.formatHeader('apex', 'devSandbox', d), '▶ Apex · devSandbox · 20:41:03');
  assert.equal(lib.formatHeader('soql', null, d, 1234), '▶ SOQL · default org · 20:41:03 · 1.2 s');
  assert.equal(lib.formatDuration(850), '850 ms');
  assert.equal(lib.formatDuration(65000), '1 min 5 s');
});

// ---------------------------------------------------------------------------
// package and grammar
// ---------------------------------------------------------------------------

test('package.json: manifest fields, commands registered, files shipped', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'virga');
  assert.equal(pkg.displayName, 'Virga: Apex Scratch & Quick Fixes');
  assert.equal(pkg.publisher, 'WiktorMayska');
  assert.equal(pkg.version, '0.1.1');
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.main, './extension.js');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.vsce, { dependencies: false });
  assert.equal(pkg.dependencies, undefined);
  const ext = fs.readFileSync(path.join(ROOT, 'src', 'scratch', 'extension.js'), 'utf8');
  for (const c of pkg.contributes.commands) assert.ok(ext.includes(`'${c.command}'`), `${c.command} registered`);
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['virga.scratch.timeoutSeconds'].default, 120);
  assert.equal(props['virga.scratch.maxColumnWidth'].default, 40);
  assert.equal(props['virga.scratch.clearOutputOnRun'].default, true);
  const outputLanguage = pkg.contributes.grammars[0].language;
  assert.ok(pkg.contributes.languages.some((l) => l.id === outputLanguage), 'grammar language contributed');
  assert.ok(ext.includes(`'${outputLanguage}'`), 'output channel uses the contributed language');
  const grammarPath = path.join(ROOT, pkg.contributes.grammars[0].path);
  assert.ok(fs.existsSync(grammarPath));
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  for (const f of ['package.json', 'extension.js', 'src/scratch/extension.js', 'src/scratch/lib.js', 'LICENSE', 'README.md', pkg.contributes.grammars[0].path.replace(/^\.\//, '')]) {
    assert.ok(ignore.includes(`!${f}`), `${f} shipped`);
  }
  // when-clause regexes of the run button and palette entry must match scratch paths only
  const when = pkg.contributes.menus['editor/title/run'][0].when;
  assert.equal(pkg.contributes.menus.commandPalette[0].when, when);
  const fileRe = new RegExp(/resourceFilename =~ \/(.+?)\/ /.exec(when)[1]);
  const dirRe = new RegExp(/resourceDirname =~ \/(.+?)\/$/.exec(when)[1]);
  assert.ok(fileRe.test('scratch-3.apex') && fileRe.test('scratch-10.soql') && !fileRe.test('scratch-3.cls') && !fileRe.test('my-scratch-3.apex'));
  assert.ok(dirRe.test('c:\\w\\proj\\.sfdx\\virga-scratch') && dirRe.test('/w/proj/.sfdx/virga-scratch') && !dirRe.test('/w/proj/force-app'));
});

// VS Code 1.141 gives an extension keybinding the weight 400 + (its index + 1) in
// contributes.keybindings, and the higher weight wins on the same key. The IntelliJ
// keymap (k--kato 1.7.8) binds ctrl+s -> Save All at index 184 of 220, so the
// scratch's ctrl+s has to sit after index 220. The padding entries have no key:
// VS Code creates no rule for them and lists them nowhere, but they use up indices.
test('package.json: ctrl+s -> virga.scratch.run outranks the IntelliJ keymap, only in scratch editors', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const kb = pkg.contributes.keybindings;
  const at = kb.findIndex((k) => k.key === 'ctrl+s');
  assert.equal(at, kb.length - 1, 'the only real keybinding, last');
  assert.ok(at > 220, `index ${at}`);
  for (const pad of kb.slice(0, at)) {
    assert.deepEqual(Object.keys(pad), ['command'], 'padding: no key on any platform, so no rule');
  }
  const run = kb[at];
  assert.equal(run.command, 'virga.scratch.run');
  assert.equal(run.mac, 'cmd+s');
  const menuWhen = pkg.contributes.menus['editor/title/run'][0].when;
  assert.equal(run.when, `editorTextFocus && ${menuWhen}`);
  // VIRGA_INTELLIJ_KEYMAP: a folder holding a copy of the keymap extension; any installed copy is checked too.
  const installed = path.join(os.homedir(), '.vscode', 'extensions');
  const candidates = process.env.VIRGA_INTELLIJ_KEYMAP ? [path.join(process.env.VIRGA_INTELLIJ_KEYMAP, 'package.json')] : [];
  try {
    for (const d of fs.readdirSync(installed)) if (/^k--kato\.intellij-idea-keybindings-/.test(d)) candidates.push(path.join(installed, d, 'package.json'));
  } catch (err) {
    // no extensions folder
  }
  for (const file of candidates.filter((f) => fs.existsSync(f))) {
    const theirs = JSON.parse(fs.readFileSync(file, 'utf8')).contributes.keybindings;
    const save = theirs.findIndex((k) => (k.win || k.key) === 'ctrl+s');
    assert.ok(at > save && at >= theirs.length, `${file}: theirs at ${save} of ${theirs.length}, ours at ${at}`);
  }
});

test('grammar: valid JSON, every regex compiles, Id pattern matches Ids and not words', () => {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes', 'virga-output.tmLanguage.json'), 'utf8'));
  assert.equal(g.scopeName, 'source.virga-output');
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const k of ['match', 'begin', 'end']) if (typeof node[k] === 'string') new RegExp(node[k]); // JS and Oniguruma agree on these constructs
    Object.values(node).forEach(walk);
  };
  walk(g);
  const id = new RegExp(g.repository['record-id'].match, 'g');
  for (const s of ['001Dm0000AbC001AAA', '003Dm0000AbC013AAA', '500Dm0000AbC018AAA', '005Dm0000AbC024', 'a0X5e000000AbCd']) {
    assert.deepEqual(`x ${s},`.match(id), [s], s);
  }
  for (const s of ['Transportation', 'Biotechnology', 'Communications', 'hello42world', '2026-10-07', '350000000', 'AnonymousBlock', 'a_young@exampleco.com', '0010000000000000000000']) {
    assert.equal(`x ${s} y`.match(id), null, s);
  }
});

// Tokenizes real formatter output with VS Code's own TextMate engine and theme files.
test('grammar in VS Code\'s TextMate engine: scopes and colors in Dark+, Light+, Dark 2026 and GitHub Dark Colorblind', async () => {
  const { createHost } = require('./textmate-host');
  const host = await createHost();
  if (!host) return 'skipped: VS Code installation not found';
  const d = new Date(2026, 9, 13, 20, 41, 3);
  const sample = [
    lib.formatHeader('apex', 'devSandbox', d, 3456),
    ...apexLines('apex-success'),
    lib.formatHeader('apex', 'devSandbox', d, 2900),
    ...apexLines('apex-exception', 1),
    ...apexLines('apex-compile-error', 1),
    lib.formatHeader('soql', 'devSandbox', d, 1200),
    ...soqlLines('soql-types'),
    ...soqlLines('soql-subquery'),
    ...soqlLines('soql-invalid-field'),
  ].join('\n');
  const tokens = host.tokenize(sample);
  const find = (text) => {
    for (const line of tokens) for (const t of line) if (t.text.trim() === text) return t.scopes.join(' ');
    return null;
  };
  const expect = {
    '▶': /keyword\.control/,
    Apex: /markup\.heading.*entity\.name\.type/,
    '✔ Compiled': /markup\.inserted/,
    '✔ Executed': /markup\.inserted/,
    '✖ Exception: System.MathException: Divide by 0': /invalid\.illegal/,
    'DEBUG': /support\.type/,
    'WARN': /keyword\.control/,
    'ERROR': /invalid\.illegal/,
    '001Dm0000AbC001AAA': /constant\.other\.record-id/,
    '350000000': /constant\.numeric/,
    'false': /constant\.language/,
    'null': /constant\.language/,
    "'a'": /string\.quoted/,
    'AnnualRevenue': /markup\.bold.*entity\.name\.tag/,
    '[2 rows]': /comment/,
    '^': /invalid\.illegal/,
    'Limits': /keyword\.other/,
    '✔ 3 records': /markup\.inserted/,
  };
  for (const [text, re] of Object.entries(expect)) {
    const scopes = find(text);
    assert.ok(scopes, `token ${JSON.stringify(text)} not found`);
    assert.match(scopes, re, `${text} -> ${scopes}`);
  }
  for (const word of ['Burlington', 'Edge', 'Communications', 'records']) {
    const scopes = tokens.flat().filter((t) => t.text.includes(word) && /record-id/.test(t.scopes.join(' ')));
    assert.equal(scopes.length, 0, `${word} colored as an Id`);
  }

  // Colors: what each key token actually looks like under real themes.
  const themeRoot = path.join(host.app, 'extensions', 'theme-defaults', 'themes');
  const themes = [
    ['Dark+', path.join(themeRoot, 'dark_plus.json'), true],
    ['Light+', path.join(themeRoot, 'light_plus.json'), true],
    ['Dark 2026', path.join(themeRoot, '2026-dark.json'), false],
    ['Light 2026', path.join(themeRoot, '2026-light.json'), false],
  ];
  const ghDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const gh = fs.readdirSync(ghDir).filter((d2) => /^github\.github-vscode-theme-/.test(d2)).sort().pop();
    if (gh) themes.push(['GitHub Dark Colorblind', path.join(ghDir, gh, 'themes', 'dark-colorblind.json'), true]);
  } catch (err) {
    // theme not installed
  }
  const keyTokens = ['✔ Compiled', '✖ Exception: System.MathException: Divide by 0', '▶', 'DEBUG', 'WARN', '001Dm0000AbC001AAA', '350000000', 'null', 'AnnualRevenue', '^', '20:41:03'];
  const report = [];
  for (const [name, file, strict] of themes) {
    if (!fs.existsSync(file)) continue;
    const theme = host.loadTheme(file);
    const { lines, defaultFg } = host.colorize(sample, theme);
    // tokenizeLine2 merges neighbours with equal styling, so look tokens up by position.
    const colorOf = (text) => {
      for (const line of lines) {
        const at = line.map((t) => t.text).join('').indexOf(text);
        if (at < 0) continue;
        let offset = 0;
        for (const t of line) {
          if (at >= offset && at < offset + t.text.length) return t;
          offset += t.text.length;
        }
      }
      return null;
    };
    const row = keyTokens.map((t) => {
      const tok = colorOf(t);
      return `${t.length > 12 ? `${t.slice(0, 11)}…` : t}=${tok ? tok.fg : '?'}${tok && tok.bold ? '(b)' : ''}`;
    });
    const plain = keyTokens.filter((t) => {
      const tok = colorOf(t);
      return !tok || tok.fg === defaultFg;
    });
    report.push(`${name} [default ${defaultFg}] ${row.join(' ')}${plain.length ? `  UNCOLORED: ${plain.join(', ')}` : ''}`);
    if (strict) assert.deepEqual(plain, [], `${name}: tokens left in the default color`);
    const ok = colorOf('✔ Compiled').fg;
    const bad = colorOf('✖ Exception: System.MathException: Divide by 0').fg;
    assert.notEqual(ok, bad, `${name}: success and error share a color`);
  }
  return report.join('\n      ');
});

test('grammar: strings stay inside a table cell, long numbers are not Ids, empty debug lines are colored', async () => {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'syntaxes', 'virga-output.tmLanguage.json'), 'utf8'));
  const id = new RegExp(g.repository['record-id'].match, 'g');
  for (const s of ['100000000000000', '480000123456789', '202610130000000', '100000000000000000']) assert.equal(`x ${s} y`.match(id), null, s);
  assert.deepEqual('x 001Dm0000AbC001AAA y'.match(id), ['001Dm0000AbC001AAA']);

  const { createHost } = require('./textmate-host');
  const host = await createHost();
  if (!host) return 'skipped: VS Code installation not found';
  const records = [
    { attributes: {}, Id: '01tDm0000AbC025AAA', Name: '27" monitor', Description: 'Stand for 32" screens', Qty: 100000000000000, Phone: '480000123456789' },
    { attributes: {}, Id: '01tDm0000AbC026AAA', Name: "it's", Description: '{"payload":"a very long json body that gets truncated here"}', Qty: 1, Phone: "'quoted'" },
  ];
  const table = lib.formatSoqlOutcome({ type: 'records', records, totalSize: 2, done: true, warnings: [] }, '', { maxColumnWidth: 30 });
  const debug = lib.formatApexOutcome({ type: 'success', logs: '12:00:00.1 (1)|USER_DEBUG|[3]|DEBUG|\n12:00:00.1 (2)|USER_DEBUG|[4]|ERROR|\n', line: null, column: null, warnings: [] }, '');
  const tokens = host.tokenize([...table, ...debug].join('\n')).flat();
  const bad = tokens.filter((t) => t.text.includes('│') && /string/.test(t.scopes.join(' ')));
  assert.deepEqual(bad.map((t) => t.text), [], 'a border inside a string token');
  for (const n of ['100000000000000', '480000123456789']) {
    const t = tokens.find((x) => x.text === n);
    assert.ok(t && !/record-id/.test(t.scopes.join(' ')), `${n}: ${t && t.scopes.join(' ')}`);
  }
  const scopesOf = (text) => tokens.filter((t) => t.text === text).map((t) => t.scopes.join(' '));
  assert.ok(scopesOf('DEBUG').some((s) => /support\.type\.level/.test(s)), JSON.stringify(scopesOf('DEBUG')));
  assert.ok(scopesOf('ERROR').some((s) => /invalid\.illegal\.level/.test(s)), JSON.stringify(scopesOf('ERROR')));
  assert.ok(tokens.some((t) => t.text === '3' && /comment\.line\.marker.*constant\.numeric\.line/.test(t.scopes.join(' '))), 'line marker of an empty debug');
  const omitted = host.tokenize('  … 8437 of 22000 debug messages omitted (output limit)').flat();
  assert.ok(omitted.every((t) => /comment\.line\.note/.test(t.scopes.join(' '))), JSON.stringify(omitted));
  return undefined;
});

// ---------------------------------------------------------------------------
// extension.js in a fake VS Code (test/fake-vscode.js): auto save, runs, tabs, shutdown
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT_ROOT = path.join(ROOT, '.dev-cache', 'ext-project');

function extProject() {
  fs.rmSync(EXT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(EXT_ROOT, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(EXT_ROOT, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app","default":true}]}');
  fs.writeFileSync(path.join(EXT_ROOT, '.sf', 'config.json'), '{"target-org":"devSandbox"}');
  fs.writeFileSync(path.join(EXT_ROOT, 'other.txt'), 'other\n');
  return EXT_ROOT;
}

/**
 * extension.js with lib.runScratch replaced by a recorder; nothing reaches sf.
 * Each run records the file sf would get and what that file held when sf
 * started (`read`); `control.hold` (a promise) keeps the "sf" of the next runs busy.
 * `grace`: how long a discarded scratch's file stays (the extension's own
 * default is 2 minutes; 0 removes it as soon as it is discarded).
 */
async function withExtension(fn, { before, logPath, grace = 0, globalState } = {}) {
  const root = extProject();
  const { loadExtension } = require('./fake-vscode');
  const realRun = lib.runScratch;
  const runs = [];
  const control = { hold: null };
  lib.runScratch = async (file, opts) => {
    let read = null;
    try {
      read = fs.readFileSync(file, 'utf8');
    } catch (err) {
      read = null;
    }
    const run = { file, opts, read, killed: false };
    runs.push(run);
    if (typeof opts.onStart === 'function') opts.onStart({ kill() { run.killed = true; } });
    if (control.hold) await control.hold;
    return { kind: lib.scratchKind(file), ms: 5, ok: true, lines: ['✔ Compiled  ✔ Executed', '', `  [line 1] DEBUG  ran ${path.basename(file)}`] };
  };
  const dir = lib.scratchDir(root);
  const options = { before: before ? (vscode) => before(vscode, { root, dir }) : undefined };
  if (logPath !== undefined) options.logPath = logPath;
  if (globalState) options.globalState = globalState;
  const loaded = loadExtension(root, options);
  if (grace !== null) loaded.api.setDiscardGraceMs(grace);
  try {
    return await fn({ ...loaded, root, runs, control, dir });
  } finally {
    loaded.dispose();
    lib.runScratch = realRun;
  }
}

/** The run folder writeRunFile made for `runFile`: <tmp>/virga-run-<this pid>-XXXXXX. */
function assertRunFile(runFile, scratchFile) {
  const dir = path.dirname(runFile);
  assert.ok(lib.samePath(path.dirname(dir), os.tmpdir()), `${runFile} lies in the temp folder`);
  assert.match(path.basename(dir), new RegExp(`^virga-run-${process.pid}-`));
  assert.equal(path.basename(runFile), path.basename(scratchFile), 'same name, so the kind (apex / soql) is the same');
  assert.ok(!lib.samePath(runFile, scratchFile), 'sf never gets the scratch file itself');
}

/** The workspace id the extension writes into its owner file for a window of `p` (a folder or a .code-workspace file). */
function wsId(vscode, p) {
  const id = vscode.Uri.file(p).toString();
  return IS_WIN ? id.toLowerCase() : id;
}

async function waitUntil(fn, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

test('package.json: apex-anon and soql get a short auto save, so a scratch is never dirty in the UI and closes without asking', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const kind of Object.values(lib.KINDS)) {
    const d = pkg.contributes.configurationDefaults[`[${kind.language}]`];
    assert.ok(d, kind.language);
    // VS Code (filesConfigurationService) counts afterDelay <= 1000 ms as "short": FileEditorInput.isSaving()
    // is true while dirty, so the tab shows no dirty dot and editorGroupView.shouldConfirmClose is false.
    assert.equal(d['files.autoSave'], 'afterDelay', kind.language);
    assert.ok(d['files.autoSaveDelay'] >= 0 && d['files.autoSaveDelay'] <= 100, `${kind.language}: debounce at most 100 ms`);
    // Either would switch auto save off for a scratch (errors in half-typed code; files outside the workspace).
    assert.equal(d['files.autoSaveWhenNoErrors'], false);
    assert.equal(d['files.autoSaveWorkspaceFilesOnly'], false);
    // The language is registered here too, so the default applies even without the Salesforce Extension Pack.
    const lang = pkg.contributes.languages.find((l) => l.id === kind.language);
    assert.deepEqual(lang, { id: kind.language, extensions: [kind.ext] }, 'no aliases or grammar: Salesforce\'s own definition stays in charge');
  }
});

// No extensionDependencies: the scratch runs with sf alone, so a missing
// Salesforce Extension Pack costs highlighting and completion, not the feature.
test('extension: without the Salesforce Extension Pack a scratch still opens and runs; one hint per installation, none with the pack', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.extensionDependencies, undefined);
  assert.equal(pkg.extensionPack, undefined);
  const hints = (vscode) => vscode.__infoMessages.filter((m) => /Salesforce Extension Pack/.test(m));
  const installation = new Map(); // context.globalState, shared by the windows below
  const without = (vscode) => vscode.extensions.installed.clear();

  await withExtension(async ({ vscode, runs }) => {
    const apex = await vscode.commands.executeCommand('virga.scratch.newApex');
    assert.ok(apex && fs.existsSync(apex.fsPath), 'scratch created');
    await vscode.commands.executeCommand('virga.scratch.newSoql');
    assert.equal(hints(vscode).length, 1, 'one hint, not one per scratch');
    assert.match(hints(vscode)[0], /^Virga: Apex highlighting and completion come from the Salesforce Extension Pack, which is not installed\. Running with Ctrl\+S needs only the Salesforce CLI\.$/);
    assert.equal(installation.get('virga.extensionPackHintShown'), true);
    vscode.__focus(apex.fsPath);
    await vscode.commands.executeCommand('virga.scratch.run');
    await waitUntil(() => runs.length === 1);
    assert.equal(runs.length, 1, 'runs without the pack');
  }, { before: without, globalState: installation });

  await withExtension(async ({ vscode }) => {
    await vscode.commands.executeCommand('virga.scratch.newApex');
    assert.equal(hints(vscode).length, 0, 'already shown on this installation');
  }, { before: without, globalState: installation });

  await withExtension(async ({ vscode }) => {
    await vscode.commands.executeCommand('virga.scratch.newApex');
    await vscode.commands.executeCommand('virga.scratch.newSoql');
    assert.equal(hints(vscode).length, 0, 'pack installed: no hint');
  });
});

test('extension: activation runs virga.scratch.run once as a no-op, so VS Code resolves its activation event before the first Ctrl+S', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    // In the extension host this local call fires onCommand:virga.scratch.run in the workbench
    // ($fireCommandActivationEvent); until that event is resolved VS Code makes every Ctrl+S
    // wait for a round trip, and keys typed right after it would get into the run.
    assert.deepEqual(vscode.commands.executed, ['virga.scratch.run']);
    await sleep(50);
    assert.deepEqual([runs.length, api.stats().runs, api.stats().queueLength], [0, 0, 0]);
    assert.deepEqual([vscode.__infoMessages, vscode.__errorMessages, vscode.__statusMessages, api.outputText()], [[], [], [], ''], 'nothing shown');
  });
});

test('extension: typing never runs anything; VS Code\'s auto save writes the text after a 100 ms pause; nothing is shown', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    assert.equal(doc.languageId, 'apex-anon', 'the language the auto save default is attached to');
    assert.equal(api.autoSaveDelay(doc), 100);
    const typed = "System.debug('typed');\n";
    for (const ch of typed) {
      vscode.__type(doc, ch);
      await sleep(10); // faster than the debounce
    }
    assert.equal(vscode.__saves.length, 0, 'debounced: nothing written while typing');
    assert.ok(await waitUntil(() => !doc.isDirty, 1000), 'clean after the pause');
    assert.deepEqual(vscode.__saves.map((s) => s.via), ['auto'], 'one auto save for the whole burst');
    assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), doc.text, 'file holds exactly the editor text');
    await sleep(300);
    assert.equal(runs.length, 0, 'a save never runs the scratch');
    assert.equal(api.outputText(), '', 'nothing written to the output channel');
    assert.deepEqual([vscode.__statusMessages, vscode.__errorMessages, vscode.__infoMessages], [[], [], []], 'and nothing shown');
  });
});

test('extension: Ctrl+S right after typing runs the text shown at that moment, at once, from its own temporary copy; nothing is saved', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    vscode.__saveDelayMs = 25;
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    vscode.__type(doc, "System.debug('one');\n");
    vscode.__type(doc, "System.debug('newest');\n");
    const shown = doc.text;
    const t0 = Date.now();
    await vscode.commands.executeCommand('virga.scratch.run'); // Ctrl+S in the same tick as the last keystroke
    assert.ok(Date.now() - t0 < 50, `the command returned after ${Date.now() - t0} ms: no waiting for a save`);
    await api.whenIdle();
    assert.equal(runs.length, 1);
    assertRunFile(runs[0].file, uri.fsPath);
    assert.equal(runs[0].read, shown, 'sf read exactly the text shown at Ctrl+S');
    assert.equal(runs[0].opts.source, shown, 'error carets point into that same text');
    assert.equal(fs.existsSync(path.dirname(runs[0].file)), false, 'the temporary copy is gone after the run');
    assert.equal(api.stats().lastRunFile, runs[0].file);
    assert.equal(vscode.__saves.length, 0, 'the run itself saved nothing');
    assert.ok(await waitUntil(() => !doc.isDirty, 1000), 'the background save still writes the scratch');
    assert.deepEqual(vscode.__saves.map((s) => s.via), ['auto'], 'only VS Code\'s auto save, never an explicit save (no format on save, no trimming)');
    await vscode.commands.executeCommand('virga.scratch.run'); // clean: runs again
    await api.whenIdle();
    await sleep(200);
    assert.equal(runs.length, 2, 'one run per Ctrl+S');
    assert.equal(runs[1].read, shown);
    assert.equal(vscode.__saves.length, 1);
    assert.equal(vscode.__maxInFlight, 1);
    assert.deepEqual([vscode.__errorMessages, vscode.__prompts], [[], []]);
  });
});

test('extension: keys typed after Ctrl+S are not part of that run, and the run never saves (it used to wait up to 1.6 s for the auto save, then save explicitly)', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    vscode.__saveDelayMs = 10;
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    vscode.__type(doc, "System.debug('base');\n");
    await waitUntil(() => !doc.isDirty, 1000);
    const saves0 = vscode.__saves.length;
    vscode.__type(doc, 'X;');
    const atCtrlS = doc.text;
    vscode.commands.executeCommand('virga.scratch.run');
    // typing goes on at 60 ms per key for about 2 s: the auto save never gets its 100 ms pause
    const after = `System.debug(42);${' '.repeat(14)}Integer y;`;
    for (const ch of after) {
      vscode.__type(doc, ch);
      await sleep(60);
    }
    await api.whenIdle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].read, atCtrlS, 'the run got the text shown at Ctrl+S, nothing typed later');
    assert.equal(doc.text, `${atCtrlS}${after}`, 'every key typed after Ctrl+S is still in the editor');
    assert.ok(await waitUntil(() => !doc.isDirty, 1000));
    assert.deepEqual(vscode.__saves.slice(saves0).map((s) => s.via), ['auto'], 'one auto save once the typing paused, no explicit save');
    assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), doc.text);
  });
});

test('extension: undo back to the saved version while a write is in flight (VS Code reports the scratch clean, the disk holds the undone key): Ctrl+S runs what the editor shows', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    vscode.__saveDelayMs = 200; // a big scratch: the write takes a while
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    vscode.__type(doc, "System.debug('undo race');\n// ");
    assert.ok(await waitUntil(() => !doc.isDirty, 2000));
    const clean = doc.text;
    vscode.__type(doc, 'Z');
    assert.ok(await waitUntil(() => vscode.__saves.length === 2, 1000), 'the auto save of "Z" started');
    vscode.__undoToSaved(doc, clean); // Ctrl+Z while that write runs
    await sleep(400);
    assert.equal(doc.isDirty, false, 'VS Code reports it clean');
    assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), `${clean}Z`, 'while the undone key sits on disk');
    await vscode.commands.executeCommand('virga.scratch.run');
    await api.whenIdle();
    assert.equal(runs[0].read, clean, 'the run has the editor text, not the stale file');
  });
});

test('extension: a failed background save (read-only file) is retried once the file can be written: no dirty state left, closing asks nothing', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    await sleep(50);
    fs.chmodSync(uri.fsPath, 0o444); // another program makes it unwritable for a while
    try {
      vscode.__type(doc, 'x');
      assert.ok(await waitUntil(() => vscode.__saves.some((s) => s.via === 'auto' && s.failed), 1000), 'the auto save failed');
      assert.equal(doc.isDirty, true);
      assert.equal(doc.saveError, true, 'VS Code\'s error state: the dirty dot shows and closing would ask');
      await sleep(1700); // past the first retries (600 ms, then 1 s later)
      assert.ok(api.stats().saveRetriesSkipped >= 2, JSON.stringify(api.stats()));
      assert.equal(vscode.__saves.filter((s) => s.via === 'explicit').length, 0, 'no save attempt while the file is unwritable, so VS Code shows no "failed to save" notification');
    } finally {
      fs.chmodSync(uri.fsPath, 0o644);
    }
    assert.ok(await waitUntil(() => !doc.isDirty, 4000), 'saved by the retry once the file is writable again');
    assert.equal(doc.saveError, false);
    assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), doc.text);
    assert.equal(api.stats().saveRetries, 1);
    assert.equal(api.stats().saveWatches, 0, 'nothing left to watch');
    vscode.__closeTab(vscode.__tabOf(uri.fsPath));
    assert.deepEqual(vscode.__prompts, [], 'closing asks nothing');
    assert.ok(await waitUntil(() => !fs.existsSync(uri.fsPath), 2000), 'and the file is deleted');
    assert.equal(runs.length, 0, 'saves never run anything');
  });
});

test('extension: the save retry stays out of the way: not while typing goes on, not when the auto save works, not when the user turned auto save off', async () => {
  await withExtension(async ({ vscode, api }) => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    for (let i = 0; i < 25; i += 1) { // 2 s of typing, 80 ms per key: auto save waits, so does the retry
      vscode.__type(doc, 'a');
      await sleep(80);
    }
    assert.ok(await waitUntil(() => !doc.isDirty, 1000));
    await sleep(800);
    assert.deepEqual([api.stats().saveRetries, api.stats().saveRetriesSkipped, api.stats().saveWatches], [0, 0, 0]);
    assert.ok(vscode.__saves.every((s) => s.via === 'auto'));

    vscode.__filesConfig.autoSave = 'off'; // "[apex-anon]": { "files.autoSave": "off" }
    vscode.__type(doc, 'b');
    await sleep(1500);
    assert.equal(doc.isDirty, true, 'dirty by the user\'s choice');
    assert.deepEqual([api.stats().saveRetries, api.stats().saveWatches], [0, 0], 'not saved behind the user\'s back');
    vscode.__closeTab(vscode.__tabOf(uri.fsPath));
    assert.deepEqual(vscode.__prompts, [uri.fsPath], 'VS Code asks then, as the README says');
    assert.ok(await waitUntil(() => !fs.existsSync(uri.fsPath), 2000), 'still deleted after "Don\'t Save"');
  });
});

test('extension: auto save turned off for the language: Ctrl+S runs the shown text without saving (closing would ask then)', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    vscode.__filesConfig.autoSave = 'off'; // e.g. "[apex-anon]": { "files.autoSave": "off" } in the user's settings
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    assert.equal(api.autoSaveDelay(doc), null);
    vscode.__type(doc, "System.debug('x');\n");
    await vscode.commands.executeCommand('virga.scratch.run');
    await api.whenIdle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].read, doc.text);
    assert.deepEqual(vscode.__saves, [], 'a run never saves');
    assert.equal(doc.isDirty, true);
    vscode.__filesConfig.autoSave = 'afterDelay';
    vscode.__filesConfig.autoSaveDelay = 5000; // a long delay is not a "short" auto save either
    assert.equal(api.autoSaveDelay(doc), null);
  });
});

test('extension: closing a scratch while its run goes on deletes the file at once; quitting mid-run stops sf and leaves no file behind', async () => {
  await withExtension(async ({ vscode, api, runs, control, ext, dir }) => {
    let release;
    control.hold = new Promise((r) => { release = r; }); // sf is busy
    const a = await vscode.commands.executeCommand('virga.scratch.newApex');
    const b = await vscode.commands.executeCommand('virga.scratch.newApex');
    vscode.__type(vscode.__doc(a.fsPath), "System.debug('closed while running');");
    vscode.__focus(a.fsPath);
    await vscode.commands.executeCommand('virga.scratch.run');
    assert.ok(await waitUntil(() => runs.length === 1, 1000));
    const runFile = runs[0].file;
    vscode.__closeTab(vscode.__tabOf(a.fsPath));
    assert.ok(await waitUntil(() => !fs.existsSync(a.fsPath), 2000), 'deleted while sf still runs: sf has its own copy');
    assert.equal(api.stats().running, true);
    assert.equal(fs.existsSync(runFile), true, 'the copy stays while sf runs');
    ext.deactivate(); // the window closes before sf is done
    assert.equal(runs[0].killed, true, 'sf stopped');
    assert.equal(fs.existsSync(path.dirname(runFile)), false, 'its copy removed');
    assert.equal(fs.existsSync(a.fsPath), false);
    assert.equal(fs.existsSync(b.fsPath), true, 'the scratch still open in a tab stays (its tab comes back)');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => lib.SCRATCH_FILE.test(n)), [path.basename(b.fsPath)]);
    release();
  });
});

test('extension: Ctrl+S again while a run waits in the queue runs the newer text; closing a scratch drops its waiting run', async () => {
  await withExtension(async ({ vscode, api, runs, control }) => {
    let release;
    control.hold = new Promise((r) => { release = r; });
    await vscode.commands.executeCommand('virga.scratch.newApex');
    await vscode.commands.executeCommand('virga.scratch.run'); // a: running
    assert.ok(await waitUntil(() => runs.length === 1, 1000));
    const b = await vscode.commands.executeCommand('virga.scratch.newApex');
    const docB = vscode.__doc(b.fsPath);
    vscode.__type(docB, 'first;');
    await vscode.commands.executeCommand('virga.scratch.run'); // b: queued
    vscode.__type(docB, 'second;');
    await vscode.commands.executeCommand('virga.scratch.run'); // still queued: newer text
    const c = await vscode.commands.executeCommand('virga.scratch.newSoql');
    await vscode.commands.executeCommand('virga.scratch.run'); // c: queued
    vscode.__closeTab(vscode.__tabOf(c.fsPath)); // discarded before its turn
    await sleep(600);
    assert.equal(api.stats().queueLength, 1);
    control.hold = null;
    release();
    await api.whenIdle();
    assert.equal(runs.length, 2, 'a, then b once; c never ran');
    assert.equal(runs[1].read, docB.text, 'b ran with the text of the last Ctrl+S');
    assert.ok(runs[1].read.endsWith('first;second;'));
    assert.equal(api.stats().maxActive, 1);
  });
});

test('extension: no save ever runs a scratch (File > Save, auto save, Save All from another editor)', async () => {
  await withExtension(async ({ vscode, api, runs, root }) => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newSoql');
    const doc = vscode.__doc(uri.fsPath);
    vscode.__type(doc, ' ');
    vscode.__save(doc, vscode.TextDocumentSaveReason.Manual); // File > Save in the scratch itself
    vscode.__save(doc, vscode.TextDocumentSaveReason.AfterDelay); // auto save
    vscode.__save(doc, vscode.TextDocumentSaveReason.FocusOut);
    vscode.__openTab(path.join(root, 'other.txt'));
    vscode.__type(doc, ' ');
    vscode.__save(doc, vscode.TextDocumentSaveReason.Manual); // Save All pressed in other.txt (IntelliJ Ctrl+S)
    await sleep(400);
    await api.whenIdle();
    assert.equal(runs.length, 0);
    assert.deepEqual(vscode.__statusMessages, []);
  });
});

test('extension: closing the tab right after typing asks nothing, waits for the pending write, then deletes; the file does not come back', async () => {
  await withExtension(async ({ vscode, api, dir }) => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const doc = vscode.__doc(uri.fsPath);
    vscode.__type(doc, 'a');
    vscode.__closeTab(vscode.__tabOf(uri.fsPath)); // inside the 100 ms debounce
    assert.deepEqual(vscode.__prompts, [], 'no "save changes?" question');
    assert.ok(await waitUntil(() => !fs.existsSync(uri.fsPath), 2000), 'deleted');
    await sleep(300);
    assert.equal(fs.existsSync(uri.fsPath), false, 'and not written again by the auto save');

    // A slow disk: the auto save (started at 100 ms) is still writing when the delete is due (400 ms).
    vscode.__saveDelayMs = 700;
    const slow = await vscode.commands.executeCommand('virga.scratch.newApex');
    const slowDoc = vscode.__doc(slow.fsPath);
    vscode.__type(slowDoc, 'c');
    vscode.__closeTab(vscode.__tabOf(slow.fsPath));
    await sleep(550);
    assert.equal(slowDoc.isDirty, true, 'write still in progress');
    assert.equal(fs.existsSync(slow.fsPath), true, 'delete postponed while VS Code writes it');
    assert.ok(api.stats().deferredDeletes >= 1);
    assert.ok(await waitUntil(() => !fs.existsSync(slow.fsPath), 3000), 'deleted right after the write');
    await sleep(300);
    assert.equal(fs.existsSync(slow.fsPath), false, 'and not written again');
    assert.equal(slowDoc.isClosed, true, 'VS Code let go of the document once it was written');
    assert.deepEqual(vscode.__prompts, []);
    assert.equal(fs.existsSync(dir), false, 'folder gone with the last scratch');
    assert.equal(api.stats().pendingDeletes, 0);
  });
});

test('extension: a huge result keeps the header and status at the top of the channel', async () => {
  await withExtension(async ({ vscode, api, runs }) => {
    const lines = ['✔ Compiled  ✖ Exception: System.MathException: Divide by 0', ...Array.from({ length: 30000 }, (_, i) => `  [line 4] DEBUG  ${i}${'x'.repeat(90)}`)];
    vscode.__config.clearOutputOnRun = false;
    await vscode.commands.executeCommand('virga.scratch.newApex');
    await vscode.commands.executeCommand('virga.scratch.run');
    await api.whenIdle();
    const realLength = lines.join('\n').length;
    lib.runScratch = async (file, opts) => {
      runs.push({ file, opts });
      return { kind: 'apex', ms: 7, ok: false, lines };
    };
    await vscode.commands.executeCommand('virga.scratch.run');
    await api.whenIdle();
    const text = api.outputText();
    assert.ok(realLength > 2000000);
    assert.ok(text.length <= 2000000, `${text.length}`);
    assert.match(text, /^▶ Apex · devSandbox · \d\d:\d\d:\d\d · 7 ms\n✔ Compiled {2}✖ Exception: System\.MathException: Divide by 0\n/);
    assert.match(text, /\n… output cut at 2000000 characters\n$/);
  });
});

test('extension: settings read for the project folder are resource-scoped (no VS Code warning)', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [key, prop] of Object.entries(pkg.contributes.configuration.properties)) assert.equal(prop.scope, 'resource', key);
  await withExtension(async ({ vscode, api, root }) => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    vscode.__type(vscode.__doc(uri.fsPath), ' ');
    await vscode.commands.executeCommand('virga.scratch.run');
    await api.whenIdle();
    assert.ok(vscode.__configReads.some((r) => r.section === 'virga.scratch' && lib.samePath(r.resource, root)));
    assert.ok(vscode.__configReads.some((r) => r.section === 'files' && lib.samePath(r.resource, uri.fsPath) && r.languageId === 'apex-anon'), 'auto save read for the document, with its language');
  });
});

test('extension: shutdown right after closing one of two tabs keeps the file; closing the only tab deletes it', async () => {
  await withExtension(async ({ vscode, ext }) => {
    const a = await vscode.commands.executeCommand('virga.scratch.newApex');
    const b = await vscode.commands.executeCommand('virga.scratch.newApex');
    const second = vscode.__openTab(a.fsPath, 1); // split: scratch-1 shown twice
    vscode.__closeTab(second); // close one of them...
    const onlyB = vscode.window.tabGroups.all[0].tabs.find((t) => t.input.uri.fsPath === b.fsPath);
    vscode.__closeTab(onlyB); // ...and the only tab of scratch-2
    ext.deactivate(); // extension host restarts within the 400 ms delete delay
    assert.equal(fs.existsSync(a.fsPath), true, 'still shown in the other tab');
    assert.equal(fs.existsSync(b.fsPath), false, 'closed then quit: still cleaned up');
  });
});

test('extension: another live window\'s scratch is never deleted; a dead window\'s leftovers are', async () => {
  await withExtension(async ({ vscode, api, root, dir }) => {
    const mine = await vscode.commands.executeCommand('virga.scratch.newApex');
    const ownerFile = path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window1')));
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')), { pid: process.pid, host: hostLog(NOW_SESSION, 'window1'), workspace: wsId(vscode, root), files: ['scratch-1.apex'] }, 'this window claims its tab and says which window and workspace it is');
    // Owner files as 0.1.0 wrote them (.owner-<pid>.json, no window): window 2 (alive: our parent
    // process) shows scratch-7; a crashed window left scratch-8
    const old = new Date(Date.now() - 3600 * 1000);
    for (const n of [7, 8]) {
      fs.writeFileSync(path.join(dir, `scratch-${n}.apex`), 'x\n');
      fs.utimesSync(path.join(dir, `scratch-${n}.apex`), old, old);
    }
    const dead = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
    const deadPid = Number(dead.stdout);
    fs.writeFileSync(path.join(dir, lib.ownerFileName(null, process.ppid)), JSON.stringify({ pid: process.ppid, files: ['scratch-7.apex', 'scratch-1.apex'] }));
    fs.writeFileSync(path.join(dir, lib.ownerFileName(null, deadPid)), JSON.stringify({ pid: deadPid, files: ['scratch-8.apex'] }));
    const removed = api.cleanupLeftovers(0).map((f) => path.basename(f));
    assert.deepEqual(removed, ['scratch-8.apex']);
    assert.equal(fs.existsSync(path.join(dir, 'scratch-7.apex')), true, 'open in window 2');
    assert.equal(fs.existsSync(path.join(dir, lib.ownerFileName(null, deadPid))), false, 'stale owner file removed');
    // closing my tab while window 2 also shows scratch-1: kept
    vscode.__closeTab(vscode.window.tabGroups.all[0].tabs.find((t) => t.input.uri.fsPath === mine.fsPath));
    await sleep(600);
    assert.equal(fs.existsSync(mine.fsPath), true, 'window 2 still shows it');
    assert.equal(fs.existsSync(ownerFile), false, 'no tabs left here: owner file gone');
    // window 2 goes away: now the leftovers can go, and the folder with them
    fs.unlinkSync(path.join(dir, lib.ownerFileName(null, process.ppid)));
    api.cleanupLeftovers(0);
    assert.equal(fs.existsSync(dir), false, `left: ${fs.existsSync(dir) ? fs.readdirSync(dir) : ''}`);
  });
});

// Restored tabs. loadExtension's host lives in <EXT_ROOT>/.dev-logs/logs/<NOW_SESSION>/window1: the
// window this test's extension host serves. OLD_SESSION is the VS Code that ran before the restart.
const LOGS = path.join(EXT_ROOT, '.dev-logs', 'logs');
const NOW_SESSION = '20261014T120000';
const OLD_SESSION = '20261014T110000';
const hostLog = (session, window, logs = LOGS) => path.join(logs, session, window, 'exthost', 'WiktorMayska.virga');
const scratchTabNames = (vscode, dir) => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.input.uri.fsPath).filter((f) => lib.isScratchFile(f, dir)).map((f) => path.basename(f)).sort();
const scratchFilesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => lib.SCRATCH_FILE.test(n)).sort() : []);

/** A process that stays alive until killed: a process id another program now owns. */
function liveStranger() {
  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  return { pid: child.pid, kill: () => child.kill() };
}

test('extension: restored scratch tabs whose files are gone are closed during activation, in one request, asking nothing; other tabs stay', async () => {
  await withExtension(async ({ vscode, api, root, dir }) => {
    const call = vscode.__closeCalls[0];
    assert.ok(call, 'a close request');
    assert.equal(call.duringActivation, true, 'sent while activate() ran: before other extensions get going');
    assert.equal(call.preserveFocus, true);
    assert.deepEqual(call.files.map((f) => path.basename(f)).sort(), ['scratch-1.apex', 'scratch-1.soql', 'scratch-2.apex'], 'all of them at once (one by one would bring the next one to the front)');
    assert.ok(await waitUntil(() => scratchTabNames(vscode, dir).length === 0, 1000), 'no scratch tab left');
    const left = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => path.relative(root, t.input.uri.fsPath)).sort();
    assert.deepEqual(left, [path.join('.sfdx', 'virga-scratch', 'notes.txt'), path.join('force-app', 'scratch-1.apex'), 'other.txt'].sort(), 'tabs that are not scratches stay, even if their file is gone');
    assert.deepEqual([...api.stats().tabsClosedMissing].sort(), ['scratch-1.apex', 'scratch-1.soql', 'scratch-2.apex']);
    assert.deepEqual([api.stats().tabsClosedRestored, api.stats().tabsKeptRestored], [[], []]);
    assert.equal(vscode.__closeCalls.length, 1, 'closed once');
    await sleep(600); // the deletes that follow every closed scratch tab
    assert.deepEqual([vscode.__prompts, vscode.__errorMessages, vscode.__infoMessages, vscode.__statusMessages, api.outputText()], [[], [], [], [], ''], 'nothing asked, nothing shown');
    assert.deepEqual(vscode.commands.executed, ['virga.scratch.run'], 'only the warm-up');
    assert.equal(fs.existsSync(dir), false, 'and no file or folder created for them');
    assert.equal(api.stats().pendingDeletes, 0);
  }, {
    before: (vscode, { root, dir }) => {
      // The files went while VS Code was closed; their tabs come back anyway.
      vscode.__restoreTab(path.join(dir, 'scratch-1.apex'), { shown: true }); // the active editor
      vscode.__restoreTab(path.join(dir, 'scratch-2.apex')); // a background tab, never shown
      vscode.__restoreTab(path.join(root, 'other.txt'), { shown: true });
      vscode.__restoreTab(path.join(root, 'force-app', 'scratch-1.apex')); // named like a scratch, not in the folder
      vscode.__restoreTab(path.join(dir, 'notes.txt')); // in the folder, not a scratch
      vscode.__restoreTab(path.join(dir, 'scratch-1.soql'), { group: 1, preview: true });
    },
  });
});

test('extension: after a restart of VS Code its restored scratch tabs are closed and their files deleted; a scratch another live window shows stays; a reused process id does not keep a dead window\'s claim', async () => {
  const stranger = liveStranger();
  try {
    await withExtension(async ({ vscode, api, dir }) => {
      assert.equal(vscode.__closeCalls[0] && vscode.__closeCalls[0].duringActivation, true, 'closed while activating');
      assert.ok(await waitUntil(() => scratchTabNames(vscode, dir).join() === 'scratch-3.apex', 1000), scratchTabNames(vscode, dir).join());
      assert.ok(await waitUntil(() => scratchFilesIn(dir).join() === 'scratch-3.apex', 2000), `files left: ${scratchFilesIn(dir)}`);
      assert.deepEqual([...api.stats().tabsClosedRestored].sort(), ['scratch-1.apex', 'scratch-1.soql', 'scratch-2.apex', 'scratch-4.apex']);
      assert.deepEqual(api.stats().tabsKeptRestored, ['scratch-3.apex'], 'window 2 of this VS Code still shows it');
      assert.deepEqual(api.stats().tabsClosedMissing, []);
      const mine = JSON.parse(fs.readFileSync(path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window1'))), 'utf8'));
      assert.deepEqual(mine.files, ['scratch-3.apex']);
      assert.ok(lib.samePath(mine.host, hostLog(NOW_SESSION, 'window1')), 'the owner file names this window');
      await sleep(300);
      assert.deepEqual(scratchFilesIn(dir), ['scratch-3.apex'], 'nothing written back');
      await waitUntil(() => !api.stats().startup, 6000); // the startup sweep
      const owners = fs.readdirSync(dir).filter((n) => lib.OWNER_FILE.test(n)).sort();
      assert.deepEqual(owners, [hostLog(NOW_SESSION, 'window1'), hostLog(NOW_SESSION, 'window2')].map((h) => lib.ownerFileName(h)).sort(), 'the owner files of the VS Code that exited are gone, the reused id\'s too');
      assert.deepEqual([vscode.__prompts, vscode.__errorMessages, vscode.__infoMessages, api.outputText()], [[], [], [], '']);
      // The kept one is a normal scratch from here on: closing it while window 2 shows it keeps the file.
      await vscode.window.tabGroups.close(vscode.__tabsFor(path.join(dir, 'scratch-3.apex')));
      await sleep(600);
      assert.equal(fs.existsSync(path.join(dir, 'scratch-3.apex')), true);
    }, {
      before: (vscode, { dir }) => {
        fs.mkdirSync(dir, { recursive: true });
        for (const n of ['scratch-1.apex', 'scratch-2.apex', 'scratch-3.apex', 'scratch-4.apex', 'scratch-1.soql']) fs.writeFileSync(path.join(dir, n), `// ${n}\n`);
        const dead = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
        // The extension host of the VS Code that was closed: process gone.
        lib.writeClaims(dir, ['scratch-1.apex', 'scratch-2.apex', 'scratch-1.soql'], Number(dead.stdout), hostLog(OLD_SESSION, 'window1'));
        // Another window of that same old VS Code; its process id now belongs to a stranger.
        lib.writeClaims(dir, ['scratch-4.apex'], stranger.pid, hostLog(OLD_SESSION, 'window2'));
        // Window 2 of the VS Code running now (alive: this test's parent process).
        lib.writeClaims(dir, ['scratch-3.apex'], process.ppid, hostLog(NOW_SESSION, 'window2'));
        vscode.__restoreTab(path.join(dir, 'scratch-1.apex'), { shown: true });
        vscode.__restoreTab(path.join(dir, 'scratch-2.apex'), { preview: true });
        vscode.__restoreTab(path.join(dir, 'scratch-3.apex'));
        vscode.__restoreTab(path.join(dir, 'scratch-4.apex'));
        vscode.__restoreTab(path.join(dir, 'scratch-1.soql'), { group: 1 });
      },
    });
  } finally {
    stranger.kill();
  }
});

test('extension: a reload or an extension host restart keeps the window\'s scratches (same window, earlier host), and they work as before', async () => {
  await withExtension(async ({ vscode, api, runs, dir }) => {
    await sleep(100);
    assert.deepEqual(vscode.__closeCalls, [], 'nothing closed');
    assert.deepEqual(scratchTabNames(vscode, dir), ['scratch-1.apex', 'scratch-2.soql']);
    assert.deepEqual([...api.stats().tabsKeptRestored].sort(), ['scratch-1.apex', 'scratch-2.soql']);
    const ownerFile = path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window1')));
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid, process.pid, 'the window\'s owner file is this host\'s now');
    assert.deepEqual(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).files.sort(), ['scratch-1.apex', 'scratch-2.soql'], 'claimed by this host now');
    const file = path.join(dir, 'scratch-1.apex');
    const doc = vscode.__docFor(file);
    vscode.__type(doc, "System.debug('after reload');\n");
    vscode.__focus(file);
    await vscode.commands.executeCommand('virga.scratch.run');
    await api.whenIdle();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].read, doc.text);
    const n = await vscode.commands.executeCommand('virga.scratch.newApex');
    assert.equal(path.basename(n.fsPath), 'scratch-2.apex', 'numbering goes on from the files that are there');
    await vscode.window.tabGroups.close(vscode.__tabsFor(file));
    assert.ok(await waitUntil(() => !fs.existsSync(file), 2000), 'closing it deletes it');
    assert.deepEqual(vscode.__prompts, []);
  }, {
    before: (vscode, { dir }) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'scratch-1.apex'), '// one\n');
      fs.writeFileSync(path.join(dir, 'scratch-2.soql'), 'SELECT Id FROM Account\n');
      const dead = require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
      lib.writeClaims(dir, ['scratch-1.apex', 'scratch-2.soql'], Number(dead.stdout), hostLog(NOW_SESSION, 'window1')); // this window, its previous host
      vscode.__restoreTab(path.join(dir, 'scratch-1.apex'), { shown: true });
      vscode.__restoreTab(path.join(dir, 'scratch-2.soql'));
    },
  });
});

test('extension: restored tabs that reach the extension after activation are judged the same way until the startup sweep; a scratch opened by hand after it stays', async () => {
  await withExtension(async ({ vscode, api, dir }) => {
    assert.deepEqual(vscode.__closeCalls, []);
    // The workbench sends its tab model late, with a restored scratch and one whose file is gone.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scratch-1.apex'), '// restored\n');
    vscode.__replaceTabModel([{ file: path.join(dir, 'scratch-1.apex') }, { file: path.join(dir, 'scratch-9.apex'), group: 1 }]);
    assert.ok(await waitUntil(() => scratchTabNames(vscode, dir).length === 0, 1000), scratchTabNames(vscode, dir).join());
    assert.deepEqual(api.stats().tabsClosedRestored, ['scratch-1.apex']);
    assert.deepEqual(api.stats().tabsClosedMissing, ['scratch-9.apex']);
    assert.ok(await waitUntil(() => !fs.existsSync(path.join(dir, 'scratch-1.apex')), 2000), 'deleted with its tab');
    // A scratch made here during startup is never taken for a restored one.
    const made = await vscode.commands.executeCommand('virga.scratch.newApex');
    vscode.__replaceTabModel(); // e.g. a group added: same tabs, new objects
    await sleep(100);
    assert.deepEqual(scratchTabNames(vscode, dir), [path.basename(made.fsPath)]);
    await sleep(5200); // the startup sweep: from here on, scratch tabs that show up are kept
    fs.writeFileSync(path.join(dir, 'scratch-5.apex'), '// opened by hand\n');
    vscode.__openTab(path.join(dir, 'scratch-5.apex'));
    await sleep(200);
    assert.deepEqual(scratchTabNames(vscode, dir), [path.basename(made.fsPath), 'scratch-5.apex'].sort());
    assert.deepEqual([vscode.__prompts, vscode.__errorMessages, vscode.__infoMessages], [[], [], []]);
  });
});

test('extension: a scratch file deleted behind VS Code\'s back closes its tabs (every group) within about a second, at once when the window gets the focus; the other scratches stay', async () => {
  await withExtension(async ({ vscode, api, dir }) => {
    const a = await vscode.commands.executeCommand('virga.scratch.newApex');
    const b = await vscode.commands.executeCommand('virga.scratch.newApex');
    const c = await vscode.commands.executeCommand('virga.scratch.newSoql');
    vscode.__openTab(a.fsPath, 1); // also in a second group
    await sleep(50);
    fs.unlinkSync(a.fsPath); // say, git clean, or another program
    const t0 = Date.now();
    assert.ok(await waitUntil(() => vscode.__tabsFor(a.fsPath).length === 0, 2500), 'both tabs of the deleted scratch closed');
    const ms = Date.now() - t0;
    assert.ok(ms < 1600, `${ms} ms`);
    assert.deepEqual(api.stats().tabsClosedMissing, ['scratch-1.apex', 'scratch-1.apex']);
    assert.deepEqual(scratchTabNames(vscode, dir), ['scratch-1.soql', 'scratch-2.apex']);
    assert.ok(fs.existsSync(b.fsPath) && fs.existsSync(c.fsPath));
    await sleep(600);
    assert.equal(fs.existsSync(a.fsPath), false, 'not brought back');

    fs.unlinkSync(b.fsPath);
    vscode.__windowFocus(true); // back to VS Code after deleting it elsewhere
    const t1 = Date.now();
    assert.ok(await waitUntil(() => vscode.__tabsFor(b.fsPath).length === 0, 2000));
    assert.ok(Date.now() - t1 < 700, `${Date.now() - t1} ms after the focus`);

    // Unsaved text and auto save turned off by the user: VS Code would ask, so the tab stays.
    vscode.__filesConfig.autoSave = 'off';
    const docC = vscode.__doc(c.fsPath);
    vscode.__type(docC, ' WHERE Name = null');
    fs.unlinkSync(c.fsPath);
    await sleep(1600);
    assert.equal(vscode.__tabsFor(c.fsPath).length, 1, 'kept: asking would be worse');
    assert.deepEqual([vscode.__prompts, vscode.__errorMessages, vscode.__infoMessages, api.outputText()], [[], [], [], '']);
    vscode.__filesConfig.autoSave = 'afterDelay';
  });
});

test('extension: a scratch file another program holds locked (stat fails with EBUSY) is not taken for a deleted one: its tab stays', async () => {
  await withExtension(async ({ vscode, api }) => {
    const a = await vscode.commands.executeCommand('virga.scratch.newApex');
    const realStat = fs.statSync;
    fs.statSync = function stat(p, ...rest) {
      if (typeof p === 'string' && lib.samePath(p, a.fsPath)) {
        const err = new Error(`EBUSY: resource busy or locked, stat '${p}'`);
        err.code = 'EBUSY';
        throw err;
      }
      return realStat.call(this, p, ...rest);
    };
    try {
      vscode.__windowFocus(true);
      await sleep(1600); // the focus check and at least one regular one
      assert.equal(vscode.__tabsFor(a.fsPath).length, 1, 'still open');
      assert.deepEqual([api.stats().tabsClosedMissing, vscode.__closeCalls], [[], []]);
    } finally {
      fs.statSync = realStat;
    }
  });
});

test('extension: a restored scratch with unsaved text (hot exit) is closed when VS Code would not ask, deleted after VS Code writes it; kept when the user turned auto save off', async () => {
  const dirtyRestore = (vscode, { dir }) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'scratch-1.apex'), '// on disk\n');
    vscode.__restoreTab(path.join(dir, 'scratch-1.apex'), { shown: true, dirty: '// on disk\nSystem.debug(1);\n' });
  };
  await withExtension(async ({ vscode, api, dir }) => {
    const file = path.join(dir, 'scratch-1.apex');
    assert.ok(await waitUntil(() => vscode.__tabsFor(file).length === 0, 1000));
    assert.deepEqual(vscode.__prompts, [], 'short auto save: VS Code closes it without asking');
    assert.ok(await waitUntil(() => !fs.existsSync(file), 3000), 'deleted once VS Code has written it');
    await sleep(300);
    assert.equal(fs.existsSync(file), false, 'and stays deleted');
    assert.deepEqual(api.stats().tabsClosedRestored, ['scratch-1.apex']);
  }, { before: dirtyRestore });
  await withExtension(async ({ vscode, api, dir }) => {
    await sleep(300);
    const file = path.join(dir, 'scratch-1.apex');
    assert.equal(vscode.__tabsFor(file).length, 1, 'kept');
    assert.deepEqual([vscode.__prompts, vscode.__closeCalls], [[], []], 'nothing asked');
    assert.deepEqual(api.stats().tabsKeptRestored, ['scratch-1.apex']);
    assert.equal(fs.existsSync(file), true);
    vscode.__filesConfig.autoSave = 'afterDelay';
  }, {
    before: (vscode, ctx) => {
      vscode.__filesConfig.autoSave = 'off';
      dirtyRestore(vscode, ctx);
    },
  });
});

/** Another window on the project withExtension made: its own fake VS Code (tabs, documents), `logPath` names it. */
function openWindow(root, { before, logPath, grace = 0 } = {}) {
  const { loadExtension } = require('./fake-vscode');
  const dir = lib.scratchDir(root);
  const loaded = loadExtension(root, { before: before ? (vscode) => before(vscode, { root, dir }) : undefined, logPath });
  if (grace !== null) loaded.api.setDiscardGraceMs(grace);
  return loaded;
}

/** The id of a process that has ended. */
function deadPid() {
  return Number(require('child_process').spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }).stdout);
}

/** What the owner file of the window that `host` serves says, or null. */
function ownerOf(dir, host) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, lib.ownerFileName(host)), 'utf8'));
  } catch (err) {
    return null;
  }
}

test('extension: a closed scratch\'s file stays for a grace period, so a tool that started on it (Code Analyzer scans on open, reads the file a minute later) still finds it; its waiting run goes at once; reopening keeps it; closing the window removes it', async () => {
  await withExtension(async ({ vscode, api, runs, control, dir, ext }) => {
    const a = await vscode.commands.executeCommand('virga.scratch.newApex');
    const b = await vscode.commands.executeCommand('virga.scratch.newApex');
    const c = await vscode.commands.executeCommand('virga.scratch.newSoql');
    // A tool starts on scratch-1 the way Code Analyzer's analyze-on-open does: it reads the file later.
    const scan = (file, ms) => sleep(ms).then(() => fs.existsSync(file));
    let release;
    control.hold = new Promise((r) => { release = r; });
    vscode.__focus(c.fsPath);
    await vscode.commands.executeCommand('virga.scratch.run'); // busy...
    vscode.__focus(a.fsPath);
    await vscode.commands.executeCommand('virga.scratch.run'); // ...so scratch-1 waits in the queue
    assert.equal(api.stats().queueLength, 1);
    const scanA = scan(a.fsPath, 1200);
    const t0 = Date.now();
    vscode.__closeTab(vscode.__tabsFor(a.fsPath)[0]);
    assert.ok(await waitUntil(() => api.stats().pendingDiscards === 1, 1500), 'discarded');
    assert.equal(api.stats().queueLength, 0, 'its waiting run went with the tab');
    assert.ok(fs.existsSync(a.fsPath), 'the file is still there');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window1'))), 'utf8')).files.sort(), ['scratch-1.soql', 'scratch-2.apex'], 'and no longer claimed');
    assert.equal(await scanA, true, 'the tool finds the file it started on');
    assert.ok(await waitUntil(() => !fs.existsSync(a.fsPath), 3000), 'removed when the grace period is over');
    const ms = Date.now() - t0;
    assert.ok(ms >= 1400 + 400 - 50, `${ms} ms after the close: 400 ms delete delay + 1.4 s grace`);
    release();
    control.hold = null;
    await api.whenIdle();
    assert.deepEqual(runs.map((r) => path.basename(r.file)), ['scratch-1.soql'], 'the discarded scratch never ran');

    // Reopened within the grace period (Reopen Closed Editor): a scratch again, its file stays.
    vscode.__closeTab(vscode.__tabsFor(b.fsPath)[0]);
    assert.ok(await waitUntil(() => api.stats().pendingDiscards === 1, 1500));
    vscode.__openTab(b.fsPath);
    assert.equal(api.stats().pendingDiscards, 0, 'the grace period is called off');
    await sleep(1800);
    assert.ok(fs.existsSync(b.fsPath) && vscode.__tabsFor(b.fsPath).length === 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window1'))), 'utf8')).files.sort(), ['scratch-1.soql', 'scratch-2.apex'], 'claimed again');

    // The window closes during a grace period: the file goes with it.
    vscode.__closeTab(vscode.__tabsFor(c.fsPath)[0]);
    assert.ok(await waitUntil(() => api.stats().pendingDiscards === 1, 1500));
    assert.ok(fs.existsSync(c.fsPath));
    ext.deactivate();
    assert.equal(fs.existsSync(c.fsPath), false, 'removed at shutdown');
    assert.equal(fs.existsSync(b.fsPath), true, 'the scratch still open stays for its restored tab');
    assert.deepEqual([vscode.__prompts, vscode.__errorMessages, vscode.__infoMessages], [[], [], []]);
  }, { grace: 1400 });
  await withExtension(async ({ api }) => {
    assert.equal(api.discardGraceMs(), 2 * 60 * 1000, 'two minutes unless a test says otherwise');
  }, { grace: null });
});

test('extension: Reload Window while another window closes its own scratch in the gap: the reloading window\'s owner file stays, its next host keeps its scratch (2026-10-14: it was closed and deleted)', async () => {
  const wsFile = path.join(EXT_ROOT, 'proj.code-workspace');
  await withExtension(async ({ vscode: v1, root, dir, ext: ext1 }) => {
    const mine = await v1.commands.executeCommand('virga.scratch.newApex');
    const doc = v1.__docFor(mine.fsPath);
    v1.__type(doc, "System.debug('typed before the reload');\n");
    assert.ok(await waitUntil(() => !doc.isDirty, 1000));
    const text = doc.text;
    // Window 2: the same project through a .code-workspace file.
    const w2 = openWindow(root, { logPath: hostLog(NOW_SESSION, 'window2'), before: (vscode) => { vscode.workspace.workspaceFile = vscode.Uri.file(wsFile); } });
    try {
      const s2 = await w2.vscode.commands.executeCommand('virga.scratch.newApex');
      const s3 = await w2.vscode.commands.executeCommand('virga.scratch.newApex');
      assert.deepEqual([s2, s3].map((u) => path.basename(u.fsPath)), ['scratch-2.apex', 'scratch-3.apex']);
      assert.equal(ownerOf(dir, hostLog(NOW_SESSION, 'window2')).workspace, wsId(v1, wsFile));
      // Window 1 reloads: its extension host goes down; the process is gone before the next one starts.
      ext1.deactivate();
      const ownerFile = path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window1')));
      const before = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      lib.writeClaims(dir, before.files, deadPid(), before.host, before.workspace);
      // In the gap, window 2 closes one of its own scratches and sweeps leftovers: both read window 1's owner file.
      w2.vscode.__closeTab(w2.vscode.__tabsFor(s2.fsPath)[0]);
      assert.ok(await waitUntil(() => !fs.existsSync(s2.fsPath), 2000), 'window 2\'s own closed scratch goes');
      w2.api.cleanupLeftovers(0);
      assert.ok(fs.existsSync(ownerFile), 'window 1\'s owner file is still there');
      assert.ok(fs.existsSync(mine.fsPath), 'and its scratch, too');
      // Window 1's next extension host, with the tab VS Code kept open across the reload.
      const w1b = openWindow(root, { before: (vscode) => vscode.__restoreTab(mine.fsPath, { shown: true }) });
      try {
        await sleep(300);
        assert.deepEqual([w1b.api.stats().tabsKeptRestored, w1b.api.stats().tabsClosedRestored, w1b.vscode.__closeCalls], [['scratch-1.apex'], [], []], 'kept, nothing closed');
        assert.equal(ownerOf(dir, hostLog(NOW_SESSION, 'window1')).pid, process.pid, 'the window\'s owner file belongs to its new host');
        assert.ok(await waitUntil(() => !w1b.api.stats().startup, 6000));
        assert.equal(fs.readFileSync(mine.fsPath, 'utf8'), text, 'the text typed before the reload is there');
        assert.equal(w1b.vscode.__tabsFor(mine.fsPath).length, 1);
        assert.deepEqual(ownerOf(dir, hostLog(NOW_SESSION, 'window1')).files, ['scratch-1.apex']);
        assert.ok(fs.existsSync(s3.fsPath), 'window 2\'s other scratch stays');
        assert.deepEqual([w1b.vscode.__prompts, w1b.vscode.__errorMessages, w2.vscode.__errorMessages], [[], [], []]);
      } finally {
        w1b.dispose();
      }
    } finally {
      w2.dispose();
    }
  });
});

test('extension: VS Code restarted with two windows that both showed the same scratch: both close their restored tab, neither claims it meanwhile, the file goes (2026-10-14: one window kept it)', async () => {
  const wsFile = path.join(EXT_ROOT, 'proj.code-workspace');
  let folderWindow = null;
  // The window of the .code-workspace activates first; the folder window right after it,
  // while the first one's close request is still on its way.
  await withExtension(async ({ vscode, api, root, dir }) => {
    folderWindow = openWindow(root, { before: (v) => v.__restoreTab(path.join(dir, 'scratch-4.apex'), { shown: true }) });
    try {
      assert.deepEqual([ownerOf(dir, hostLog(NOW_SESSION, 'window2')), ownerOf(dir, hostLog(NOW_SESSION, 'window1'))], [null, null], 'a window closing its restored tabs claims none of them');
      const f = folderWindow;
      assert.ok(await waitUntil(() => scratchTabNames(vscode, dir).length === 0 && scratchTabNames(f.vscode, dir).length === 0, 1000), 'both closed their restored scratch tabs');
      assert.deepEqual([api.stats().tabsKeptRestored, f.api.stats().tabsKeptRestored], [[], []], 'neither kept one');
      assert.deepEqual([[...api.stats().tabsClosedRestored].sort(), f.api.stats().tabsClosedRestored], [['scratch-3.apex', 'scratch-4.apex'], ['scratch-4.apex']]);
      assert.ok(await waitUntil(() => !f.api.stats().startup && !api.stats().startup, 6000));
      assert.ok(await waitUntil(() => scratchFilesIn(dir).length === 0, 2000), `files left: ${scratchFilesIn(dir)}`);
      assert.equal(fs.existsSync(dir), false, 'the owner files of the VS Code that exited went with them');
      assert.deepEqual([vscode.__prompts, f.vscode.__prompts, vscode.__errorMessages, f.vscode.__errorMessages], [[], [], [], []]);
    } finally {
      folderWindow.dispose();
    }
  }, {
    logPath: hostLog(NOW_SESSION, 'window2'),
    before: (vscode, { root, dir }) => {
      fs.mkdirSync(dir, { recursive: true });
      for (const n of ['scratch-3.apex', 'scratch-4.apex']) fs.writeFileSync(path.join(dir, n), `// ${n}\n`);
      vscode.workspace.workspaceFile = vscode.Uri.file(wsFile);
      lib.writeClaims(dir, ['scratch-4.apex'], deadPid(), hostLog(OLD_SESSION, 'window1'), wsId(vscode, root)); // the folder window
      lib.writeClaims(dir, ['scratch-3.apex', 'scratch-4.apex'], deadPid(), hostLog(OLD_SESSION, 'window2'), wsId(vscode, wsFile)); // the workspace window
      vscode.__restoreTab(path.join(dir, 'scratch-3.apex'));
      vscode.__restoreTab(path.join(dir, 'scratch-4.apex'), { shown: true });
    },
  });
});

test('extension: a scratch a closed window of another workspace kept waits for that workspace (no sweep deletes it, so its restored tab never flashes "file not found"); that workspace closes and deletes it; after 7 days anyone may', async () => {
  const wsFile = path.join(EXT_ROOT, 'proj.code-workspace');
  const LATER = '20261014T130000';
  const parked = (vscode, { root, dir }, ageMs = 0) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'scratch-1.apex');
    fs.writeFileSync(file, "System.debug('left open in the workspace window');\n");
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(file, hourAgo, hourAgo); // old enough for the leftover sweep
    lib.writeClaims(dir, ['scratch-1.apex'], deadPid(), hostLog(OLD_SESSION, 'window1'), wsId(vscode, wsFile));
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(path.join(dir, lib.ownerFileName(hostLog(OLD_SESSION, 'window1'))), t, t);
    }
  };
  // The project opened as a folder after the .code-workspace window was closed with scratch-1 open.
  await withExtension(async ({ vscode, api, root, dir }) => {
    assert.deepEqual(api.cleanupLeftovers(0), [], 'not a leftover: its workspace restores its tab');
    assert.ok(await waitUntil(() => !api.stats().startup, 6000)); // and the startup sweep
    assert.deepEqual(scratchFilesIn(dir), ['scratch-1.apex']);
    assert.ok(fs.existsSync(path.join(dir, lib.ownerFileName(hostLog(OLD_SESSION, 'window1')))), 'its owner file stays too');
    // Closing a tab of it here (Quick Open) does not delete it either.
    vscode.__openTab(path.join(dir, 'scratch-1.apex'));
    await sleep(50);
    vscode.__closeTab(vscode.__tabsFor(path.join(dir, 'scratch-1.apex'))[0]);
    await sleep(600);
    assert.deepEqual(scratchFilesIn(dir), ['scratch-1.apex']);
    // The .code-workspace opens again (a later start of VS Code): it restores the tab, closes it, deletes the file.
    const w = openWindow(root, {
      logPath: hostLog(LATER, 'window1'),
      before: (v) => {
        v.workspace.workspaceFile = v.Uri.file(wsFile);
        v.__restoreTab(path.join(dir, 'scratch-1.apex'), { shown: true });
      },
    });
    try {
      assert.ok(await waitUntil(() => scratchTabNames(w.vscode, dir).length === 0, 1000));
      assert.deepEqual([w.api.stats().tabsClosedRestored, w.api.stats().tabsClosedMissing, w.api.stats().tabsKeptRestored], [['scratch-1.apex'], [], []], 'its file was there: closed as restored, not as missing');
      assert.ok(await waitUntil(() => scratchFilesIn(dir).length === 0, 2000), 'and deleted');
      assert.ok(await waitUntil(() => !w.api.stats().startup, 6000));
      assert.equal(fs.existsSync(dir), false, 'with the owner file of the window it took over');
    } finally {
      w.dispose();
    }
  }, { before: (vscode, ctx) => parked(vscode, ctx) });
  // Never opened again within 7 days of its VS Code exiting: an ordinary leftover.
  await withExtension(async ({ api, dir }) => {
    assert.deepEqual(api.cleanupLeftovers().map((f) => path.basename(f)), ['scratch-1.apex']);
    assert.equal(fs.existsSync(dir), false);
  }, { before: (vscode, ctx) => parked(vscode, ctx, 8 * 24 * 3600 * 1000) });
});

test('extension: a window closed and opened again in the same VS Code session takes over its scratches: restored tabs closed, files deleted; a window that ended in this session is never swept by another one', async () => {
  await withExtension(async ({ vscode, api, root, dir }) => {
    // Window 3 of this session was closed with scratch-1 open; window 2 (a reload in progress?) with scratch-2.
    assert.ok(await waitUntil(() => scratchTabNames(vscode, dir).length === 0, 1000));
    assert.deepEqual(api.stats().tabsClosedRestored, ['scratch-1.apex']);
    assert.ok(await waitUntil(() => !api.stats().startup, 6000));
    assert.deepEqual(api.cleanupLeftovers(0), []);
    assert.deepEqual(scratchFilesIn(dir), ['scratch-2.apex'], 'its own scratch deleted; the other window\'s kept');
    assert.ok(!fs.existsSync(path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window3')))));
    assert.ok(fs.existsSync(path.join(dir, lib.ownerFileName(hostLog(NOW_SESSION, 'window2')))));
  }, {
    logPath: hostLog(NOW_SESSION, 'window4'),
    before: (vscode, { root, dir }) => {
      fs.mkdirSync(dir, { recursive: true });
      const hourAgo = new Date(Date.now() - 3600 * 1000);
      for (const n of ['scratch-1.apex', 'scratch-2.apex']) {
        fs.writeFileSync(path.join(dir, n), `// ${n}\n`);
        fs.utimesSync(path.join(dir, n), hourAgo, hourAgo);
      }
      lib.writeClaims(dir, ['scratch-1.apex'], deadPid(), hostLog(NOW_SESSION, 'window3'), wsId(vscode, root));
      lib.writeClaims(dir, ['scratch-2.apex'], deadPid(), hostLog(NOW_SESSION, 'window2'), wsId(vscode, path.join(root, 'proj.code-workspace')));
      vscode.__restoreTab(path.join(dir, 'scratch-1.apex'), { shown: true });
    },
  });
});

test('owners: the window comes from the host\'s log folder and names its owner file; the next host of the same window writes the same file', () => {
  const logs = path.join('C:\\Users\\u\\AppData\\Roaming\\Code', 'logs');
  const id = lib.hostIdentity(path.join(logs, '20261014T212200', 'window3', 'exthost', 'WiktorMayska.virga'), 'win32');
  assert.deepEqual(id, { logsHome: 'c:\\users\\u\\appdata\\roaming\\code\\logs', session: '20261014t212200', window: 'window3' });
  assert.deepEqual(lib.hostIdentity('/home/u/.config/Code/logs/20261014T212200/window1/exthost/x', 'linux'), { logsHome: '/home/u/.config/Code/logs', session: '20261014T212200', window: 'window1' });
  assert.equal(lib.hostIdentity('/home/u/.vscode-server/data/logs/20261014T212200/exthost1/x', 'linux'), null, 'another layout: unknown, so only the process id counts');
  assert.equal(lib.hostIdentity(null), null);
  const w1 = hostLog('S1', 'window1', logs);
  assert.match(lib.ownerFileName(w1, 1), /^\.owner-w[0-9a-f]{16}\.json$/);
  assert.ok(lib.OWNER_FILE.test(lib.ownerFileName(w1, 1)) && lib.OWNER_FILE.test('.owner-1234.json') && !lib.OWNER_FILE.test('.owner-1234.json.1.2.tmp'));
  assert.equal(lib.ownerFileName(w1, 1), lib.ownerFileName(w1, 2), 'a reload or Restart Extensions: another process, the same window, the same file');
  if (IS_WIN) assert.equal(lib.ownerFileName(w1.toUpperCase(), 1), lib.ownerFileName(w1, 1), 'paths compare without case on Windows');
  else assert.notEqual(lib.ownerFileName(w1.toUpperCase(), 1), lib.ownerFileName(w1, 1), 'case matters elsewhere');
  assert.notEqual(lib.ownerFileName(w1), lib.ownerFileName(hostLog('S1', 'window2', logs)), 'another window');
  assert.notEqual(lib.ownerFileName(w1), lib.ownerFileName(hostLog('S2', 'window1', logs)), 'the same window number in the next session');
  assert.notEqual(lib.ownerFileName(w1), lib.ownerFileName(hostLog('S1', 'window1', path.join('D:\\portable\\data', 'logs'))), 'another VS Code');
  assert.equal(lib.ownerFileName(null, 555), '.owner-555.json', 'window unknown: named after the process, as 0.1.0 did');
});

test('owners: what another window\'s owner file means (lib.ownerRole): live, this window\'s earlier host, a window of this workspace that ended, one that may come back, or gone', () => {
  const dir = path.join(ROOT, '.dev-cache', 'owners');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const logs = path.join('C:\\Users\\u\\AppData\\Roaming\\Code', 'logs');
  const folder = 'file:///c%3a/proj';
  const other = 'file:///c%3a/proj/proj.code-workspace';
  const self = { pid: 999, host: hostLog('S2', 'window1', logs), workspace: folder };
  const write = (name, pid, host, workspace) => lib.writeClaims(dir, [name], pid, host, workspace);
  write('scratch-1.apex', 111, hostLog('S1', 'window1', logs), folder); // ended (VS Code restarted), same workspace
  write('scratch-2.apex', 222, hostLog('S1', 'window2', logs), other); // ended, its process id reused; another workspace
  write('scratch-3.apex', 333, hostLog('S2', 'window2', logs), other); // another window now
  write('scratch-4.apex', 444, hostLog('S9', 'window1', path.join('D:\\portable\\data', 'logs')), folder); // another VS Code, running
  write('scratch-5.apex', 555); // window unknown (remote host, or 0.1.0), running
  write('scratch-6.apex', 666, hostLog('S2', 'window3', logs), other); // this session, ended: in the middle of a reload, or closed
  write('scratch-7.apex', 777, hostLog('S1', 'window3', logs)); // 0.1.0 (no workspace), earlier session
  write('scratch-8.apex', 888, hostLog('S2', 'window4', logs)); // 0.1.0, this session, ended
  write('scratch-9.apex', 1010); // window unknown, ended
  write('scratch-10.apex', 1111, hostLog('S0', 'window1', logs), other); // another workspace, VS Code exited 8 days ago
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(dir, lib.ownerFileName(hostLog('S0', 'window1', logs))), old, old);
  write('scratch-11.apex', 1212, hostLog('S8', 'window2', path.join('D:\\portable\\data', 'logs')), folder); // another VS Code, ended
  // This window's earlier host as 0.1.0 named it (by process id), and this host's own file.
  fs.writeFileSync(path.join(dir, '.owner-1313.json'), JSON.stringify({ pid: 1313, host: self.host, files: ['scratch-12.apex'] }));
  write('scratch-13.apex', 999, self.host, folder);
  const alive = (pid) => [222, 333, 444, 555].includes(pid);
  const roleOf = (owners) => Object.fromEntries(owners.map((o) => [o.files[0], o.role]));
  const owners = lib.ownersOf(dir, self, { isAlive: alive });
  assert.deepEqual(roleOf(owners), {
    'scratch-1.apex': 'heir', // VS Code restores this workspace's tabs into this window: they are this window's to close
    'scratch-2.apex': 'parked', // its workspace restores them when it opens again
    'scratch-3.apex': 'live',
    'scratch-4.apex': 'live',
    'scratch-5.apex': 'live',
    'scratch-6.apex': 'parked', // a reload in progress keeps its scratches
    'scratch-7.apex': 'gone',
    'scratch-8.apex': 'parked',
    'scratch-9.apex': 'gone',
    'scratch-10.apex': 'gone', // parked longer than PARKED_MAX_AGE_MS
    'scratch-11.apex': 'parked', // another VS Code's workspace storage: never this window's
    'scratch-12.apex': 'previous',
  }, 'this host\'s own file (scratch-13) is not listed');
  assert.deepEqual([...lib.claimedNames(owners, ['live'])].sort(), ['scratch-3.apex', 'scratch-4.apex', 'scratch-5.apex'], 'what other windows show: a restored tab of these stays');
  assert.deepEqual([...lib.claimedNames(owners, ['live', 'parked'])].sort(), ['scratch-11.apex', 'scratch-2.apex', 'scratch-3.apex', 'scratch-4.apex', 'scratch-5.apex', 'scratch-6.apex', 'scratch-8.apex'], 'what no other window may delete');
  assert.equal(roleOf(lib.ownersOf(dir, self, { isAlive: (pid) => alive(pid) || pid === 1313 }))['scratch-12.apex'], 'previous', 'a window has one host at a time: an earlier one is never live, even if its process id is in use again');
  assert.equal(lib.PARKED_MAX_AGE_MS, 7 * 24 * 3600 * 1000);
  assert.equal(roleOf(lib.ownersOf(dir, self, { isAlive: alive, parkedMaxAgeMs: -1 }))['scratch-2.apex'], 'gone', 'the age limit applies to windows of an earlier session');
  assert.equal(roleOf(lib.ownersOf(dir, self, { isAlive: alive, parkedMaxAgeMs: -1 }))['scratch-6.apex'], 'parked', 'never to one of this session');
  const otherWorkspace = roleOf(lib.ownersOf(dir, { ...self, workspace: other }, { isAlive: alive }));
  assert.deepEqual([otherWorkspace['scratch-1.apex'], otherWorkspace['scratch-2.apex']], ['parked', 'heir'], 'the window of the other workspace is the heir of its own windows only');
  const unknown = roleOf(lib.ownersOf(dir, { pid: 999, host: null, workspace: folder }, { isAlive: alive }));
  assert.equal(unknown['scratch-2.apex'], 'live', 'this host\'s window unknown: only the process id counts');
  assert.equal(unknown['scratch-12.apex'], 'gone', 'and nothing is this window\'s earlier host');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claims: an unreadable owner file of a live process keeps everything; one no host wrote whole is gone; names compare without case; writeClaims leaves no temporary file', () => {
  const dir = path.join(ROOT, '.dev-cache', 'claims');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  lib.writeClaims(dir, ['scratch-1.apex'], 111);
  lib.writeClaims(dir, ['Scratch-2.SOQL'], 222);
  fs.writeFileSync(path.join(dir, lib.ownerFileName(null, 333)), '{half');
  fs.writeFileSync(path.join(dir, '.owner-w0123456789abcdef.json'), '{half');
  const alive = (pid) => pid !== 444;
  const self = { pid: 111, host: null, workspace: null };
  const owners = () => lib.ownersOf(dir, self, { isAlive: alive });
  assert.deepEqual([...lib.claimedNames(owners(), ['live'])].sort(), ['*', 'scratch-2.soql'], 'this process\'s own file is not another window');
  assert.equal(owners().find((o) => o.file.endsWith('.owner-w0123456789abcdef.json')).role, 'gone');
  fs.unlinkSync(path.join(dir, lib.ownerFileName(null, 333)));
  assert.deepEqual([...lib.claimedNames(owners(), ['live'])], ['scratch-2.soql']);
  lib.writeClaims(dir, [], 222);
  assert.equal(fs.existsSync(path.join(dir, lib.ownerFileName(null, 222))), false);
  assert.ok(fs.readdirSync(dir).every((n) => !n.endsWith('.tmp')));
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(dir, lib.ownerFileName(null, 111)), old, old);
  lib.touchClaims(dir, 111, null);
  assert.ok(fs.statSync(path.join(dir, lib.ownerFileName(null, 111))).mtimeMs > old.getTime() + 1000, 'touchClaims dates the owner file now');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run copies: writeRunFile keeps the text as is in its own folder; removeRunFile and sweepRunDirs touch only such folders, never a live host\'s', () => {
  const tmp = path.join(ROOT, '.dev-cache', 'run-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const text = "System.debug('ąę €');\r\nmixed\nendings \n";
  const a = lib.writeRunFile(path.resolve('proj', '.sfdx', 'virga-scratch', 'scratch-3.apex'), text, { tmpDir: tmp, pid: 111 });
  const b = lib.writeRunFile('/proj/.sfdx/virga-scratch/scratch-1.soql', 'SELECT Id FROM Account', { tmpDir: tmp, pid: 222 });
  const c = lib.writeRunFile('scratch-3.apex', 'x', { tmpDir: tmp, pid: 111 });
  assert.equal(path.basename(a), 'scratch-3.apex');
  assert.equal(lib.scratchKind(b), 'soql');
  assert.match(path.basename(path.dirname(a)), /^virga-run-111-.+$/);
  assert.notEqual(path.dirname(a), path.dirname(c), 'every run gets its own folder');
  assert.equal(fs.readFileSync(a, 'utf8'), text, 'byte for byte: no BOM, line endings untouched');
  // a dead host's folder, and strangers in tmp named almost like ours
  const dead = path.dirname(lib.writeRunFile('scratch-2.apex', 'z', { tmpDir: tmp, pid: 333 }));
  fs.mkdirSync(path.join(tmp, 'virga-runner'));
  fs.writeFileSync(path.join(tmp, 'virga-run-333-file'), 'a file, not a run folder');
  const alive = (pid) => pid === 222;
  assert.deepEqual(lib.sweepRunDirs(tmp, 111, alive), [path.basename(dead)], 'only the dead host\'s folder; 111 is this host, 222 is alive');
  assert.ok(fs.existsSync(a) && fs.existsSync(b) && fs.existsSync(c));
  assert.ok(fs.existsSync(path.join(tmp, 'virga-runner')) && fs.existsSync(path.join(tmp, 'virga-run-333-file')));
  assert.equal(lib.sweepRunDirs(tmp, 999, () => false).length, 3, 'after the hosts died: all three run folders');
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b) && !fs.existsSync(c));
  assert.ok(fs.existsSync(path.join(tmp, 'virga-run-333-file')), 'files are never swept');
  const d = lib.writeRunFile('scratch-9.apex', 'y', { tmpDir: tmp, pid: 444 });
  assert.equal(lib.removeRunFile(d), true);
  assert.equal(fs.existsSync(path.dirname(d)), false);
  assert.equal(lib.removeRunFile(path.join(tmp, 'virga-runner', 'x.apex')), false, 'not a run folder: left alone');
  assert.equal(lib.removeRunFile(path.join(ROOT, 'src', 'scratch', 'lib.js')), false);
  assert.ok(fs.existsSync(path.join(tmp, 'virga-runner')) && fs.existsSync(path.join(ROOT, 'src', 'scratch', 'lib.js')));
  assert.equal(lib.removeRunFile(null), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// integration: real sf against the default org
// ---------------------------------------------------------------------------

const IT_ROOT = path.join(ROOT, '.it-project');
const IT_ORG = (process.env.VIRGA_TEST_ORG || '').trim();

/**
 * Why the org tests cannot run here, or null when they can: VIRGA_TEST_ORG
 * names an org, sf is on PATH and answers a query in that org.
 */
async function orgUnavailable() {
  if (process.env.SKIP_ORG === '1') return 'SKIP_ORG=1';
  if (!IT_ORG) return 'no org: set VIRGA_TEST_ORG=<alias of an org authorized in sf>';
  if (!lib.findExecutable('sf')) return 'sf (Salesforce CLI) not found on PATH';
  const res = await lib.runSf(['data', 'query', '--query', 'SELECT Id FROM Organization', '--target-org', IT_ORG, '--json'], { timeoutMs: 120000 });
  const json = lib.parseSfJson(res.stdout, res.stderr);
  if (!json || json.status !== 0) return `sf cannot query ${IT_ORG}: ${(json && (json.name || json.message)) || res.stderr.trim().split('\n')[0] || `exit ${res.code}`}`;
  return null;
}

function itProject(configOrg = IT_ORG) {
  fs.mkdirSync(path.join(IT_ROOT, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(IT_ROOT, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: '64.0' }, null, 2));
  fs.writeFileSync(path.join(IT_ROOT, '.sf', 'config.json'), JSON.stringify({ 'target-org': configOrg }, null, 2));
  fs.mkdirSync(lib.scratchDir(IT_ROOT), { recursive: true });
  return IT_ROOT;
}

/** Same call as extension.js runOne: lib.runScratch on a scratch file in a throwaway project. */
async function itRun(name, text, { configOrg, env: extraEnv, sample = true } = {}) {
  const root = itProject(configOrg);
  const file = path.join(lib.scratchDir(root), name);
  fs.writeFileSync(file, lib.toLf(text));
  const started = new Date();
  // lib.runScratch starts sf with its telemetry off (SF_ENV). With it on, sf's uploader child would
  // keep the project folder as its cwd for a while and block deleting .it-project on Windows.
  const env = { ...process.env, ...extraEnv };
  if (!extraEnv || !('SF_TARGET_ORG' in extraEnv)) delete env.SF_TARGET_ORG;
  delete env.SFDX_DEFAULTUSERNAME;
  const res = await lib.runScratch(file, { cwd: root, timeoutMs: 120000, maxColumnWidth: 40, env });
  fs.unlinkSync(file);
  const block = [lib.formatHeader(res.kind, res.org, started, res.ms), ...res.lines].join('\n');
  if (sample) samples.push(block);
  return res;
}

const ORG = { integration: true };

test('org: anonymous Apex with System.debug', async () => {
  const res = await itRun('scratch-1.apex', [
    `// Ctrl+S runs this in ${IT_ORG}. Close the tab to discard.`,
    '',
    "List<Account> accs = [SELECT Id, Name FROM Account ORDER BY Name LIMIT 2];",
    "System.debug('accounts: ' + accs.size());",
    'System.debug(LoggingLevel.WARN, accs[0]);',
    "System.debug('two\\nlines');",
    '',
  ].join('\n'));
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(res.lines[0], '✔ Compiled  ✔ Executed');
  assert.ok(res.lines.includes('  [line 4] DEBUG  accounts: 2'), res.lines.join('\n'));
  assert.ok(res.lines.some((l) => /^ {2}\[line 5\] WARN {3}Account:\{Id=001/.test(l)));
  assert.ok(res.lines.includes('  [line 6] DEBUG  two') && res.lines.includes('                  lines'));
  assert.ok(res.lines.some((l) => l.startsWith('  Limits  SOQL queries 1/100 · query rows 2/50000')));
}, ORG);

test('org: Apex compile error', async () => {
  const res = await itRun('scratch-2.apex', "Integer x = 1;\nStrin y = 'a';\n");
  assert.equal(res.outcome.type, 'compile');
  assert.deepEqual(res.lines, ['✖ Compile error line 2, column 1: Invalid type: Strin', '', "  2 │ Strin y = 'a';", '    │ ^']);
}, ORG);

test('org: Apex runtime exception (divide by zero, debug before it)', async () => {
  const res = await itRun('scratch-3.apex', "System.debug('before');\nInteger z = 0;\nInteger i = 1 / z;\n");
  assert.equal(res.outcome.type, 'exception');
  assert.equal(res.lines[0], '✔ Compiled  ✖ Exception: System.MathException: Divide by 0');
  assert.ok(res.lines.includes('  3 │ Integer i = 1 / z;'));
  assert.ok(res.lines.includes('  [line 1] DEBUG  before'));
}, ORG);

test('org: Apex null dereference', async () => {
  const res = await itRun('scratch-4.apex', 'Account acc;\nString s = acc.Name;\n');
  assert.equal(res.lines[0], '✔ Compiled  ✖ Exception: System.NullPointerException: Attempt to de-reference a null object');
}, ORG);

test('org: SOQL with relationship field and subquery', async () => {
  const res = await itRun('scratch-1.soql', 'SELECT Id, Name, Owner.Name, (SELECT Id, LastName FROM Contacts LIMIT 3)\nFROM Account\nORDER BY Name\nLIMIT 5\n');
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.match(res.lines[0], /^✔ \d+ records?$/);
  assert.match(res.lines[2], /^│ Id +│ Name +│ Owner\.Name +│ Contacts +│$/);
  assert.ok(res.lines.slice(4, -1).every((l) => /│ \[\d+ rows?\] +│$/.test(l)), res.lines.join('\n'));
}, ORG);

test('org: SOQL syntax error', async () => {
  const res = await itRun('scratch-2.soql', 'SELECT Id FROM Account WHERE\n');
  assert.equal(res.outcome.type, 'error');
  assert.match(res.lines[0], /^✖ MALFORMED_QUERY at row 1, column \d+: /);
  assert.ok(res.lines.includes('  1 │ SELECT Id FROM Account WHERE'));
}, ORG);

test('org: | inside debug messages and in an exception from a class in the scratch', async () => {
  const res = await itRun('scratch-5.apex', [
    "System.debug('a|b|c');",
    "System.debug(JSON.serialize(new Map<String, Object>{ 'k|1' => 'v<2>' }));",
    'class P { void go() { System.debug(\'in go | with pipe\'); throw new IllegalArgumentException(\'bad | thing\'); } }',
    'new P().go();',
    '',
  ].join('\n'), { sample: false });
  assert.equal(res.lines[0], '✔ Compiled  ✖ Exception: System.IllegalArgumentException: bad | thing');
  for (const l of ['  [line 1] DEBUG  a|b|c', '  [line 2] DEBUG  {"k|1":"v<2>"}', '  [line 3] DEBUG  in go | with pipe']) assert.ok(res.lines.includes(l), `${l}\n${res.lines.join('\n')}`);
  assert.ok(!res.lines.join('\n').includes('&#124;'));
}, ORG);

test('org: SOQL subquery empty in every row and relationship null in every row', async () => {
  const res = await itRun('scratch-3.soql', "SELECT Id, LastName, ReportsTo.Name, ReportsTo.Account.Name, (SELECT Id FROM Cases WHERE Subject = 'zzz_apex_scratch_none')\nFROM Contact WHERE ReportsToId = null ORDER BY LastName LIMIT 3\n", { sample: false });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.match(res.lines[2], /^│ Id +│ LastName +│ ReportsTo\.Name +│ ReportsTo\.Account\.Name +│ Cases +│$/);
  assert.ok(res.lines.slice(4, -1).every((l) => /│ null +│ null +│ \[0 rows\] │$/.test(l)), res.lines.join('\n'));
}, ORG);

test('org: SOQL error caret with leading blank lines and indentation', async () => {
  const res = await itRun('scratch-4.soql', '\n\n  SELECT Id,\n    Nme\n  FROM Account\n', { sample: false });
  assert.match(res.lines[0], /^✖ INVALID_FIELD at row 4, column 5: No such column 'Nme'/);
  assert.deepEqual(res.lines.slice(2), ['  4 │     Nme', '    │     ^']);
}, ORG);

test('org: SF_TARGET_ORG wins over the project config and goes to sf as --target-org', async () => {
  const res = await itRun('scratch-5.soql', 'SELECT Id FROM Organization\n', { configOrg: 'virgaNoSuchOrg', env: { SF_TARGET_ORG: IT_ORG }, sample: false });
  assert.equal(res.org, IT_ORG);
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(res.lines[0], '✔ 1 record');
  const bogus = await itRun('scratch-6.soql', 'SELECT Id FROM Organization\n', { configOrg: IT_ORG, env: { SF_TARGET_ORG: 'virgaNoSuchOrg' }, sample: false });
  assert.equal(bogus.org, 'virgaNoSuchOrg', 'the header names the org sf really used');
  assert.match(bogus.lines[0], /^✖ NamedOrgNotFoundError: /);
}, ORG);

// ---------------------------------------------------------------------------

(async () => {
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null; // ONLY=<regex>: just the tests whose name matches
  const wantsOrg = tests.some((t) => t.integration && (!only || only.test(t.name)));
  const noOrg = wantsOrg ? await orgUnavailable() : 'not selected';
  if (wantsOrg && noOrg) console.log(`org tests skipped: ${noOrg}`);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of tests) {
    if ((t.integration && noOrg) || (t.windowsOnly && !IS_WIN) || (only && !only.test(t.name))) {
      skipped += 1;
      console.log(`- skip ${t.name}`);
      continue;
    }
    const t0 = Date.now();
    try {
      const note = await t.fn();
      passed += 1;
      console.log(`ok   ${t.name} (${Date.now() - t0} ms)${note ? `\n      ${note}` : ''}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${t.name}\n     ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n     ')}`);
    }
  }
  try {
    // sf leaves a short-lived background process with this folder as its cwd, so Windows reports EBUSY for a while.
    fs.rmSync(IT_ROOT, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 });
  } catch (err) {
    console.log(`(could not remove ${IT_ROOT}: ${err.code})`);
  }
  if (samples.length) {
    console.log('\n--- output produced by the integration runs ---\n');
    console.log(samples.join('\n\n'));
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
