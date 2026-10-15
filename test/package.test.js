'use strict';

// The package as a whole: manifest ids, the entry point that starts both
// parts, the snippets, what the VSIX ships and what it must never contain.
// Run with: node test/package.test.js (npm test runs it too).

const assert = require('node:assert/strict');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- manifest

test('manifest: identity, links and marketplace fields', () => {
  assert.equal(pkg.name, 'virga');
  assert.equal(`${pkg.publisher}.${pkg.name}`, 'WiktorMayska.virga');
  assert.equal(pkg.displayName, 'Virga: Apex Scratch & Quick Fixes');
  assert.equal(pkg.description, "Write some Apex or SOQL, press Ctrl+S to run it, then close the tab and it's gone. Completion for local types, quick fixes and Apex snippets. Works with Salesforce CLI and the Salesforce Extension Pack.");
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author.name, 'Wiktor Małyska');
  assert.equal(pkg.repository.url, 'https://github.com/wiktormalyska/virga.git');
  assert.equal(pkg.bugs.url, 'https://github.com/wiktormalyska/virga/issues');
  assert.equal(pkg.homepage, 'https://github.com/wiktormalyska/virga#readme');
  assert.equal(pkg.icon, 'images/icon.png');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.icon)));
  for (const k of ['apex', 'soql', 'anonymous apex', 'salesforce', 'sf cli', 'snippets']) assert.ok(pkg.keywords.includes(k), k);
  assert.ok(pkg.keywords.length <= 30, 'the Marketplace takes at most 30 keywords');
  assert.ok(pkg.categories.includes('Snippets') && pkg.categories.includes('Programming Languages'));
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  assert.equal(pkg.extensionDependencies, undefined, 'the Salesforce Extension Pack is optional (see README)');
  for (const s of ['test', 'e2e', 'package']) assert.ok(pkg.scripts[s], `npm run ${s}`);
});

// The name, logo and tagline must not use Salesforce marks; "Salesforce" only as a plain reference.
test('manifest: trademark rules for the name and tagline', () => {
  for (const word of ['salesforce', 'force', 'cloud']) {
    assert.ok(!new RegExp(word, 'i').test(pkg.displayName), `displayName has "${word}"`);
    assert.ok(!new RegExp(word, 'i').test(pkg.name), `name has "${word}"`);
  }
  const refs = pkg.description.match(/Salesforce \w+/g) || [];
  assert.deepEqual(refs, ['Salesforce CLI', 'Salesforce Extension'], 'only "works with" references');
  assert.ok(pkg.description.endsWith(' Works with Salesforce CLI and the Salesforce Extension Pack.'));
});

test('manifest: activation stays lazy (a Salesforce DX workspace or an Apex file, commands implicit)', () => {
  assert.deepEqual(pkg.activationEvents, ['workspaceContains:sfdx-project.json', 'onLanguage:apex']);
  assert.equal(pkg.main, './extension.js');
});

test('manifest: every command, setting and key under the virga namespace', () => {
  const c = pkg.contributes;
  const ids = [
    ...c.commands.map((x) => x.command),
    ...c.keybindings.map((x) => x.command),
    ...Object.values(c.menus).flat().map((x) => x.command),
    ...Object.keys(c.configuration.properties),
  ];
  assert.ok(ids.length > 10);
  for (const id of ids) assert.match(id, /^virga\.scratch\.[A-Za-z]+$/, id);
  for (const cmd of c.commands) assert.equal(cmd.category, 'Virga', cmd.command);
  assert.equal(c.configuration.title, 'Virga');
  const own = c.languages.filter((l) => l.aliases).map((l) => l.id);
  assert.deepEqual(own, ['virga-output'], 'the only language of our own; apex-anon and soql are Salesforce ids');
  assert.deepEqual(c.grammars.map((g) => g.scopeName), ['source.virga-output']);
  // The source files use the same ids.
  const scratch = fs.readFileSync(path.join(ROOT, 'src', 'scratch', 'extension.js'), 'utf8');
  for (const cmd of c.commands) assert.ok(scratch.includes(`'${cmd.command}'`), `${cmd.command} registered`);
  assert.match(scratch, /getConfiguration\('virga\.scratch'/);
  assert.match(scratch, /const OUTPUT_CHANNEL = 'Virga';/);
  for (const item of ['virga.scratch.apex', 'virga.scratch.soql', 'virga.scratch.running']) assert.ok(scratch.includes(`'${item}'`), item);
  const localTypes = fs.readFileSync(path.join(ROOT, 'src', 'local-types', 'extension.js'), 'utf8');
  assert.match(localTypes, /const DIAGNOSTIC_SOURCE = 'virga';/);
});

// ---------------------------------------------------------------- entry point

/** A vscode module with everything both parts touch while activating; `fail` makes one API throw. */
function stubVscode({ fail } = {}) {
  const calls = [];
  const disposable = () => ({ dispose() {} });
  const event = (name) => () => {
    calls.push(name);
    return disposable();
  };
  const boom = (name, fn) => (...args) => {
    if (fail === name) throw new Error(`${name} failed`);
    return fn(...args);
  };
  return {
    calls,
    StatusBarAlignment: { Left: 1, Right: 2 },
    CodeActionKind: { QuickFix: 'quickfix' },
    CompletionItemKind: { Class: 6, Interface: 7, Enum: 12 },
    Uri: { file: (p) => ({ scheme: 'file', fsPath: p, toString: () => `file://${p}` }) },
    window: {
      createOutputChannel: boom('createOutputChannel', (name, language) => {
        calls.push(`output:${name}:${language}`);
        return { replace() {}, show() {}, dispose() {} };
      }),
      createStatusBarItem: (id) => {
        calls.push(`status:${id}`);
        return { show() {}, hide() {}, dispose() {} };
      },
      tabGroups: { all: [], onDidChangeTabs: event('onDidChangeTabs'), onDidChangeTabGroups: event('onDidChangeTabGroups') },
      onDidChangeWindowState: event('onDidChangeWindowState'),
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: undefined,
      workspaceFile: undefined,
      textDocuments: [],
      getConfiguration: () => ({ get: (k, d) => d }),
      onDidChangeTextDocument: event('onDidChangeTextDocument'),
      onDidCloseTextDocument: event('onDidCloseTextDocument'),
      onDidOpenTextDocument: event('onDidOpenTextDocument'),
      onDidChangeWorkspaceFolders: event('onDidChangeWorkspaceFolders'),
    },
    commands: {
      registerCommand: (id) => {
        calls.push(`command:${id}`);
        return disposable();
      },
      executeCommand: async () => undefined,
    },
    languages: {
      createDiagnosticCollection: boom('createDiagnosticCollection', (name) => {
        calls.push(`diagnostics:${name}`);
        return { set() {}, delete() {}, dispose() {} };
      }),
      registerCompletionItemProvider: (selector) => {
        calls.push(`completion:${selector.map((s) => `${s.language}/${s.scheme}`).join(',')}`);
        return disposable();
      },
      registerCodeActionsProvider: () => {
        calls.push('codeActions');
        return disposable();
      },
    },
  };
}

function loadEntry(vscode) {
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
  };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };
  for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(ROOT, 'src')) || key === path.join(ROOT, 'extension.js')) delete require.cache[key];
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const t0 = process.hrtime.bigint();
    const entry = require(path.join(ROOT, 'extension.js'));
    const loadedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const context = { subscriptions: [], globalState: { get: () => undefined, update: async () => {} } };
    const t1 = process.hrtime.bigint();
    const api = entry.activate(context);
    const activateMs = Number(process.hrtime.bigint() - t1) / 1e6;
    return { entry, api, context, errors, loadedMs, activateMs };
  } finally {
    console.error = realError;
    Module._resolveFilename = resolve;
    delete require.cache.vscode;
  }
}

test('extension.js: one activation starts both parts and returns the scratch API', () => {
  const vscode = stubVscode();
  const { entry, api, context, errors, loadedMs, activateMs } = loadEntry(vscode);
  assert.deepEqual(errors, []);
  assert.ok(vscode.calls.includes('output:Virga:virga-output'), vscode.calls.join('\n'));
  for (const id of ['virga.scratch.newApex', 'virga.scratch.newSoql', 'virga.scratch.run', 'virga.scratch.showOutput']) assert.ok(vscode.calls.includes(`command:${id}`), id);
  assert.ok(vscode.calls.includes('diagnostics:virga'));
  assert.ok(vscode.calls.includes('completion:apex/file,apex/untitled'));
  assert.ok(vscode.calls.includes('codeActions'));
  assert.equal(typeof api.whenIdle, 'function');
  assert.equal(typeof api.stats, 'function');
  assert.ok(context.subscriptions.length > 10);
  for (const d of context.subscriptions) d.dispose();
  entry.deactivate();
  assert.ok(activateMs < 500, `activate took ${activateMs} ms`);
  return `require ${loadedMs.toFixed(1)} ms, activate ${activateMs.toFixed(1)} ms (no workspace folder)`;
});

test('extension.js: a part that fails to start does not take the other one down', () => {
  const a = stubVscode({ fail: 'createOutputChannel' });
  const ra = loadEntry(a);
  assert.equal(ra.api, undefined);
  assert.ok(a.calls.includes('diagnostics:virga'), 'local types still registered');
  assert.match(ra.errors.join('\n'), /scratch part failed to start/);
  for (const d of ra.context.subscriptions) d.dispose();
  ra.entry.deactivate();

  const b = stubVscode({ fail: 'createDiagnosticCollection' });
  const rb = loadEntry(b);
  assert.equal(typeof rb.api.whenIdle, 'function', 'scratch still started');
  for (const d of rb.context.subscriptions) d.dispose();
  rb.entry.deactivate();
});

// ---------------------------------------------------------------- snippets

const SNIPPETS = Object.fromEntries(pkg.contributes.snippets.map((s) => [s.language, JSON.parse(fs.readFileSync(path.join(ROOT, s.path), 'utf8'))]));

test('snippets: one file per language, apex and soql, each entry with prefix, body and description', () => {
  assert.deepEqual(pkg.contributes.snippets.map((s) => [s.language, s.path]), [
    ['apex', './snippets/apex.code-snippets'],
    ['soql', './snippets/soql.code-snippets'],
  ]);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'snippets')).sort(), ['apex.code-snippets', 'soql.code-snippets']);
  for (const [language, file] of Object.entries(SNIPPETS)) {
    for (const [name, s] of Object.entries(file)) {
      assert.deepEqual(Object.keys(s).sort(), ['body', 'description', 'prefix'], `${language}/${name}: no "scope" in an extension snippet file`);
      for (const p of [].concat(s.prefix)) assert.ok(typeof p === 'string' && p.length > 0, `${language}/${name} prefix`);
      for (const b of [].concat(s.body)) assert.equal(typeof b, 'string', `${language}/${name} body`);
      assert.ok(s.description.length > 0);
    }
  }
  assert.equal(Object.keys(SNIPPETS.apex).length, 70);
  assert.equal(Object.keys(SNIPPETS.soql).length, 5);
});

test('snippets: annotations insert after a typed "@", keywords and user-mode SOQL as written', () => {
  const { apex, soql } = SNIPPETS;
  // VS Code does not count "@" as part of a word: prefix and body start after it.
  for (const name of ['AuraEnabled', 'InvocableMethod', 'InvocableVariable', 'IsTest', 'TestVisible', 'RestResource', 'SuppressWarnings']) {
    assert.ok(!String(apex[name].body).startsWith('@') && ![].concat(apex[name].prefix).some((p) => p.startsWith('@')), name);
  }
  assert.equal(apex.InvocableMethod.body, "InvocableMethod(\n    label='${1:Action label}'\n    description='${2:When to use it and what it returns. Agentforce shows this as the action instructions.}'\n    category='${3:Category}'\n)");
  assert.equal(apex.RestResource.body, "RestResource(urlMapping='/${1:v1/resource}/*')");
  assert.deepEqual(apex.return, { prefix: 'return', body: 'return $0;', description: 'return' });
  assert.deepEqual(apex['else if'].prefix, ['elseif', 'else if']);
  assert.equal(apex['Database user mode'].body, 'Database.${1|insert,update,upsert,delete|}(${2:records}, ${3|false,true|}, AccessLevel.USER_MODE);');
  assert.deepEqual(apex['Database.query user mode'].prefix, ['Database.queryWithBinds', 'dbqueryuser']);
  // Statements the Extension Pack ships as snippets are left to it.
  for (const name of ['if', 'if else', 'else', 'for each', 'for index', 'for soql', 'while', 'do while', 'try catch', 'try catch finally', 'switch on', 'class', 'inner class', 'custom exception', 'interface', 'enum', 'throw new']) {
    assert.equal(apex[name], undefined, `${name}: the pack has it`);
  }
  // The data access clauses work inside [SELECT ...] in a class and in .soql files.
  for (const name of Object.keys(soql)) assert.deepEqual(apex[name], soql[name], name);
  assert.deepEqual(soql['WITH USER_MODE'].prefix, ['with', 'WITH USER_MODE', 'user_mode']);
  assert.equal(soql['WITH SECURITY_ENFORCED (removed)'].body, 'USER_MODE');
});

/** Lower-cased pack prefixes per language: every snippet file the pack contributes to that language. */
function packPrefixesByLanguage(rec) {
  const byLanguage = {};
  for (const { language, path: p } of rec.snippets) {
    byLanguage[language] = byLanguage[language] || new Set();
    for (const prefix of rec.prefixes[p] || []) byLanguage[language].add(prefix.toLowerCase());
  }
  return byLanguage;
}

/** Virga prefixes the pack also uses in the same language: [`language: prefix (snippet)`]. */
function prefixClashes(rec) {
  const pack = packPrefixesByLanguage(rec);
  const clashes = [];
  for (const [language, file] of Object.entries(SNIPPETS)) {
    for (const [name, s] of Object.entries(file)) {
      for (const p of [].concat(s.prefix)) if (pack[language] && pack[language].has(p.toLowerCase())) clashes.push(`${language}: ${p} (${name})`);
    }
  }
  return clashes;
}

// The Extension Pack ships snippets for apex, apex-anon and soql
// (salesforce.apex-language-server-extension). A Virga snippet with the same
// prefix would be a second item with the same label in the suggestion list.
test('snippets: no prefix the Salesforce Extension Pack already uses (recorded copy, and the installed one when there is one)', () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sf-pack-snippets.json'), 'utf8'));
  assert.equal(recorded.extension, 'salesforce.apex-language-server-extension');
  assert.deepEqual([...new Set(recorded.snippets.map((s) => s.language))].sort(), ['apex', 'apex-anon', 'soql']);
  assert.ok(packPrefixesByLanguage(recorded).apex.has('for'), 'the recording has the statements');
  assert.deepEqual(prefixClashes(recorded), []);
  // The check itself: the snippets removed for this reason would be caught.
  const before = { ...SNIPPETS.apex, for: { prefix: ['for', 'foreach'] }, try: { prefix: 'try' } };
  const saved = SNIPPETS.apex;
  SNIPPETS.apex = before;
  try {
    assert.deepEqual(prefixClashes(recorded), ['apex: for (for)', 'apex: try (try)']);
  } finally {
    SNIPPETS.apex = saved;
  }
  const { findInstalled, readPackSnippets } = require(path.join(ROOT, 'tools', 'record-pack-snippets.js'));
  const folder = findInstalled();
  if (!folder) return `recorded ${recorded.extension} ${recorded.version}; none installed`;
  const installed = readPackSnippets(folder);
  assert.deepEqual(prefixClashes(installed), [], `installed ${installed.version}`);
  return `recorded ${recorded.version}, installed ${installed.version}${installed.version === recorded.version ? '' : ' (newer: node tools/record-pack-snippets.js)'}`;
});

// ---------------------------------------------------------------- what ships

/** The files `vsce package` puts in the VSIX: the "!" lines of .vscodeignore (it starts with "**"). */
function shipped() {
  const lines = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.equal(lines[0], '**', 'everything excluded first, then listed');
  return lines.slice(1).map((l) => {
    assert.ok(l.startsWith('!') && !/[*?[]/.test(l), `${l}: one explicit file per line`);
    return l.slice(1);
  });
}

test('.vscodeignore: runtime files, snippets, grammar, images the README shows, LICENSE, README, CHANGELOG', () => {
  const files = shipped();
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  const required = [
    'package.json', 'extension.js',
    'src/scratch/extension.js', 'src/scratch/lib.js', 'src/local-types/extension.js', 'src/local-types/lib.js',
    'syntaxes/virga-output.tmLanguage.json', 'snippets/apex.code-snippets', 'snippets/soql.code-snippets',
    'images/icon.png', 'LICENSE', 'README.md', 'CHANGELOG.md',
  ];
  for (const f of required) assert.ok(files.includes(f), `${f} shipped`);
  // Every image the README shows ships, and nothing else from images/.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const shown = [...readme.matchAll(/!\[[^\]]*\]\((images\/[^)\s]+)\)/g)].map((m) => m[1]);
  assert.ok(shown.length >= 3, 'three screenshots in the README');
  for (const img of shown) assert.ok(files.includes(img), `${img} shipped`);
  const images = files.filter((f) => f.startsWith('images/'));
  assert.deepEqual(images.sort(), ['images/icon.png', ...new Set(shown)].sort());
  // Every runtime require resolves to a shipped file.
  for (const js of files.filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, js), 'utf8');
    for (const m of src.matchAll(/require\('(\.[^']+)'\)/g)) {
      const target = path.relative(ROOT, require.resolve(path.join(ROOT, path.dirname(js), m[1]))).split(path.sep).join('/');
      assert.ok(files.includes(target), `${js} requires ${target}, which is not shipped`);
    }
  }
});

// Nothing from the author's machine: no home folders, no e-mail addresses
// except reserved example domains, no Salesforce org ids, no link to virga.dev
// (someone else's site).
/**
 * The files the repository holds or would take in: `git ls-files` (tracked plus
 * untracked, without the git-ignored test output); without git, a walk that
 * leaves out the ignored folders.
 */
function repositoryFiles() {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
  const skip = new Set(['.git', 'node_modules', '.dev-cache', '.it-project']);
  const e2eRuntime = /^e2e[\\/](vsc|udd|ws|ipc|exts|exts-vsix|shots-out|\.cache)([\\/]|$)|^e2e[\\/]e2e-out.*\.json$/;
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(ROOT, full);
      if (skip.has(ent.name) || e2eRuntime.test(rel) || /\.(log|jsonl|vsix)$/.test(ent.name)) continue;
      if (ent.isDirectory()) walk(full);
      else files.push(rel);
    }
  };
  walk(ROOT);
  return files;
}

test('no personal data in the repository', () => {
  const textFiles = repositoryFiles().filter((f) => !/\.png$/i.test(f));
  assert.ok(textFiles.length > 40, `${textFiles.length} files scanned`);
  const problems = [];
  for (const rel of textFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const home = text.match(/[A-Za-z]:[\\/]+Users[\\/]+(?!<|\$|%|\*|u[\\/]|user[\\/]|me[\\/])[A-Za-z0-9._-]+/g);
    if (home) problems.push(`${rel}: home folder ${home[0]}`);
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g)) {
      if (!/^(example\.(com|org|net)|exampleco\.com|abc\.com)$/i.test(m[1])) problems.push(`${rel}: e-mail ${m[0]}`);
    }
    const orgId = text.match(/\b00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/);
    if (orgId) problems.push(`${rel}: org id ${orgId[0]}`);
    if (/https?:\/\/(?:[\w-]+\.)*virga\.dev/i.test(text)) problems.push(`${rel}: links virga.dev`);
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------- runner

(async () => {
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;
  let failed = 0;
  let ran = 0;
  for (const { name, fn } of tests) {
    if (only && !only.test(name)) continue;
    ran += 1;
    try {
      const note = await fn();
      console.log(`ok   ${name}${note ? `  (${note})` : ''}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${name}`);
      console.log(String(err && err.stack ? err.stack : err).replace(/^/gm, '     '));
    }
  }
  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
})();
