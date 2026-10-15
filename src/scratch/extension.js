'use strict';

// VS Code wiring for Virga's scratches. Logic (paths, sf, parsing, formatting)
// lives in lib.js; this file only connects it to editors, tabs, the run
// command, the status bar and the output channel. Every event handler is
// wrapped so an error ends up in the output channel instead of escaping into
// VS Code.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const OUTPUT_CHANNEL = 'Virga';
const OUTPUT_LANGUAGE = 'virga-output';
// Highlighting and completion inside a scratch come from these extensions of the
// Salesforce Extension Pack. Without them a scratch still opens and runs (this
// extension registers the apex-anon and soql ids itself), so a missing one gets
// a single hint per installation instead of an extensionDependencies entry that
// would force the whole pack on everyone.
const LANGUAGE_EXTENSIONS = { apex: 'salesforce.salesforcedx-vscode-apex', soql: 'salesforce.salesforcedx-vscode-soql' };
const EXTENSION_PACK = 'salesforce.salesforcedx-vscode';
const PACK_HINT_KEY = 'virga.extensionPackHintShown';
// VS Code treats an "afterDelay" auto save of at most this many ms as a save in
// progress: the tab shows no dirty dot and closing it never asks to save.
// package.json sets exactly that for apex-anon and soql (configurationDefaults).
const SHORT_AUTO_SAVE_MAX_MS = 1000;
// Still dirty this long after the auto save was due, with no edit since: that
// auto save failed (file locked, read-only, disk full). VS Code then drops the
// "being saved" state, shows the dirty dot and asks on close, and retries only
// after the next edit, so the extension retries itself, with a growing pause.
const SAVE_RETRY_AFTER_MS = 500;
const SAVE_RETRY_MAX_MS = 5000;
const DELETE_DELAY_MS = 400; // a tab dragged to another group is closed and reopened in two events
const DELETE_RETRY_MS = 250; // closed while its auto save is still pending: try again shortly
const DELETE_MAX_RETRIES = 40; // ~10 s; a write landing after that is caught by the startup cleanup
// A discarded scratch's file stays this long (or until the window closes): another extension may
// have started on it while it was open (Salesforce Code Analyzer scans on open and reads the file
// a minute later) and would report a file that does not exist.
const DISCARD_GRACE_MS = 2 * 60 * 1000;
const CLEANUP_DELAY_MS = 5000; // let VS Code restore tabs before judging leftovers; also ends the startup phase
const LEFTOVER_AGE_MS = 5 * 60 * 1000;
const MISSING_CHECK_MS = 1000; // while a scratch tab is open: is its file still there?
const MISSING_CONFIRM_MS = 250; // a file found missing must still be missing this much later
const CLOSE_RETRIES = 3; // closing tabs failed (stale tab objects after the tab model was replaced)
const MAX_OUTPUT_CHARS = 2000000;
const WARM_UP = Object.freeze({ virgaWarmUp: true }); // see activate()

let state = null;

function activate(context) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL, OUTPUT_LANGUAGE);
  state = {
    output,
    outputText: '',
    queue: [], // { file, text } waiting to run: the scratch and its text at Ctrl+S
    running: null, // { file, handle, runFile }
    counters: { apex: 0, soql: 0 },
    creating: new Set(), // file keys being opened right now
    pendingDeletes: new Map(), // file key -> { timer, file }: tab closed, discarded unless it comes back
    discards: new Map(), // file key -> { timer, file, at }: discarded, file removed when the grace is over
    discardGraceMs: DISCARD_GRACE_MS,
    saveWatch: new Map(), // file key -> { timer, attempt }: scratch dirty past its auto save
    idleWaiters: [],
    // This window, as lib.hostIdentity reads it: tells a reload / extension host restart from a new start.
    host: context.logUri && context.logUri.scheme === 'file' ? context.logUri.fsPath : null,
    accepted: new Set(), // scratch keys this window keeps: created here, kept at startup, opened after it
    inherited: new Set(), // scratch keys an earlier extension host of this same window kept
    startup: true, // until the startup sweep: a scratch tab not created here is one VS Code restored
    closing: new Set(), // scratch keys whose tabs the extension is closing right now
    missingTimer: null, // checks the files of open scratch tabs while there are any
    missingConfirm: null,
    stats: {
      runs: 0,
      active: 0,
      maxActive: 0,
      queued: 0,
      saveRetries: 0, // saves the extension made because VS Code's auto save had failed
      saveRetriesSkipped: 0, // retries put off because another program still held the file
      deferredDeletes: 0, // deletes postponed because the closed document was still being written
      lastRunFile: null, // the temporary copy sf got in the last run
      tabsClosedMissing: [], // scratch tabs closed because their file was gone
      tabsClosedRestored: [], // scratch tabs VS Code restored from an earlier session, closed at startup
      tabsKeptRestored: [], // restored ones kept: shown by another live window, or this window before a reload
    },
    memento: context.globalState || null, // remembers that the Extension Pack hint was shown
    packHintShown: false,
    disposed: false,
  };

  // First of all, before other extensions get to work on them: scratch tabs
  // VS Code restored from the last session (their files may be gone).
  guard(startupTabs);

  const apexItem = vscode.window.createStatusBarItem('virga.scratch.apex', vscode.StatusBarAlignment.Left, 20);
  apexItem.name = 'Virga: new Apex scratch';
  apexItem.text = '$(play) Apex';
  apexItem.command = 'virga.scratch.newApex';
  const soqlItem = vscode.window.createStatusBarItem('virga.scratch.soql', vscode.StatusBarAlignment.Left, 19);
  soqlItem.name = 'Virga: new SOQL scratch';
  soqlItem.text = '$(database) SOQL';
  soqlItem.command = 'virga.scratch.newSoql';
  const runningItem = vscode.window.createStatusBarItem('virga.scratch.running', vscode.StatusBarAlignment.Left, 18);
  runningItem.name = 'Virga: scratch running';
  runningItem.command = 'virga.scratch.showOutput';
  Object.assign(state, { apexItem, soqlItem, runningItem, itemsVisible: false });

  context.subscriptions.push(
    output,
    apexItem,
    soqlItem,
    runningItem,
    vscode.commands.registerCommand('virga.scratch.newApex', () => newScratch('apex')),
    vscode.commands.registerCommand('virga.scratch.newSoql', () => newScratch('soql')),
    vscode.commands.registerCommand('virga.scratch.run', (uri) => (uri === WARM_UP ? undefined : runCommand(uri))),
    vscode.commands.registerCommand('virga.scratch.showOutput', () => guard(() => output.show(true))),
    vscode.window.tabGroups.onDidChangeTabs((e) => guard(() => onTabsChanged(e))),
    // The whole tab model arrives this way too (at startup, and when groups are added or removed).
    vscode.window.tabGroups.onDidChangeTabGroups(() => guard(() => { reconcileTabs(); updateClaims(); })),
    vscode.workspace.onDidChangeTextDocument((e) => guard(() => onDocumentChanged(e))),
    vscode.workspace.onDidCloseTextDocument((doc) => guard(() => onDocumentClosed(doc))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => guard(() => { refreshStatusBar(); updateClaims(); })),
    vscode.window.onDidChangeWindowState((s) => guard(() => { if (s.focused) { refreshStatusBar(); checkMissing(); } })),
    { dispose: () => shutdown() },
  );

  // The first time VS Code dispatches a contributed command, it first resolves
  // the command's activation event ("onCommand:virga.scratch.run") with a round
  // trip to this extension host, and keys typed meanwhile reach the document
  // before the command does: the first Ctrl+S of a window would run a key typed
  // right after it. Running the command here once (a no-op, the argument never
  // leaves this extension host) resolves that event up front, so from then on
  // Ctrl+S is sent to the extension ahead of every key that follows it.
  Promise.resolve(vscode.commands.executeCommand('virga.scratch.run', WARM_UP)).catch(() => {});

  refreshStatusBar();
  guard(updateClaims); // the scratch tabs kept at startup belong to this window now
  const cleanupTimer = setTimeout(() => guard(endStartup), CLEANUP_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(cleanupTimer) });

  // Small surface for the end-to-end test; harmless otherwise.
  return {
    whenIdle,
    outputText: () => state && state.outputText,
    stats: () => state && { ...state.stats, queueLength: state.queue.length, running: !!state.running, pendingDeletes: state.pendingDeletes.size, pendingDiscards: state.discards.size, saveWatches: state.saveWatch.size, startup: state.startup },
    statusBar: () => state && [apexItem, soqlItem, runningItem].map((i) => ({ text: i.text, tooltip: String(i.tooltip || '') })),
    statusBarVisible: () => !!(state && state.itemsVisible),
    autoSaveDelay: (doc) => autoSaveDelay(doc),
    cleanupLeftovers: (maxAgeMs) => cleanupLeftovers(maxAgeMs),
    discardGraceMs: () => state && state.discardGraceMs,
    setDiscardGraceMs: (ms) => setDiscardGraceMs(ms),
  };
}

function deactivate() {
  shutdown();
}

/**
 * Extension host going down (reload, restart, quit). Pending deletes run now
 * with the usual checks, against the tab state read before anything is torn
 * down: a scratch that a tab here or in another window still shows stays.
 * Discarded scratches still in their grace period go at once (the other
 * extensions go down too). VS Code has already written auto-saved documents
 * by then (it saves them before shutting down instead of asking). A run still
 * going is stopped and its temporary copy removed; sf never holds the scratch
 * file itself. The owner file stays: the next host of this window, or the
 * next window of this workspace, takes its scratches over (see lib.ownerRole).
 */
function shutdown() {
  if (!state || state.disposed) return;
  let open = null;
  try {
    open = openTabKeys();
  } catch (err) {
    open = null; // tab state unknown: delete nothing
  }
  try {
    for (const root of sfdxRoots()) lib.touchClaims(lib.scratchDir(root), process.pid, state.host);
  } catch (err) {
    // the claim just keeps its older date
  }
  state.disposed = true;
  const running = state.running;
  try {
    if (running && running.handle) running.handle.kill();
  } catch (err) {
    // nothing left to stop
  }
  if (running && running.runFile) lib.removeRunFile(running.runFile);
  clearInterval(state.missingTimer);
  clearTimeout(state.missingConfirm);
  state.missingTimer = null;
  state.missingConfirm = null;
  for (const { timer } of state.saveWatch.values()) clearTimeout(timer);
  state.saveWatch.clear();
  for (const { timer, file } of state.pendingDeletes.values()) {
    clearTimeout(timer);
    if (open) deleteScratchNow(file, open);
  }
  state.pendingDeletes.clear();
  for (const [key, entry] of [...state.discards]) {
    clearTimeout(entry.timer);
    state.discards.delete(key);
    if (open) finishDiscard(entry.file, open);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function guard(fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((err) => reportError(err));
    return r;
  } catch (err) {
    reportError(err);
    return undefined;
  }
}

function reportError(err) {
  try {
    if (!state) return;
    const msg = err && err.stack ? err.stack : String(err);
    writeOutput(state.outputText, `✖ Virga internal error: ${msg}\n`);
  } catch (e) {
    // nothing more we can do
  }
}

/** Replaces the channel text with `previous` + `block`, trimmed by lib.fitOutput (keeps the newest run's head). */
function writeOutput(previous, block) {
  const t = lib.fitOutput(previous, block, MAX_OUTPUT_CHARS);
  state.outputText = t;
  state.output.replace(t);
}

const isWin = process.platform === 'win32';
function fileKey(p) {
  const r = path.resolve(p);
  return isWin ? r.toLowerCase() : r;
}

/** Workspace folders that are Salesforce DX projects. */
function sfdxRoots() {
  const roots = [];
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (f.uri.scheme !== 'file') continue;
    try {
      if (fs.existsSync(path.join(f.uri.fsPath, 'sfdx-project.json'))) roots.push(f.uri.fsPath);
    } catch (err) {
      // unreadable folder: not a project
    }
  }
  return roots;
}

/**
 * This window's workspace: its .code-workspace file (or untitled workspace),
 * else its only folder. VS Code restores a workspace's tabs into a window of
 * that workspace only, which is what makes a window the heir of the windows of
 * the same workspace that ended before it (lib.ownerRole).
 */
function workspaceId() {
  let id = null;
  const file = vscode.workspace.workspaceFile;
  if (file) {
    id = file.toString();
  } else {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1) id = folders[0].uri.toString();
  }
  return id && isWin ? id.toLowerCase() : id;
}

/** This host as the owner files see it. */
function self() {
  return { pid: process.pid, host: state && state.host, workspace: workspaceId() };
}

/** The other windows' owner files in the scratch folder `dir`, each with its role for this one (lib.ownerRole). */
function owners(dir) {
  return lib.ownersOf(dir, self());
}

/** The project whose scratch folder holds `filePath`, or null. */
function scratchRootOf(filePath) {
  for (const root of sfdxRoots()) {
    if (lib.isScratchFile(filePath, lib.scratchDir(root))) return root;
  }
  return null;
}

function isScratchUri(uri) {
  return !!uri && uri.scheme === 'file' && !!scratchRootOf(uri.fsPath);
}

function tabUris(tab) {
  const input = tab && tab.input;
  if (!input) return [];
  const uris = [];
  if (input.uri) uris.push(input.uri);
  if (input.modified) uris.push(input.modified);
  if (input.original) uris.push(input.original);
  return uris.filter((u) => u && u.scheme === 'file');
}

function openTabKeys() {
  const keys = new Set();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) for (const uri of tabUris(tab)) keys.add(fileKey(uri.fsPath));
  }
  return keys;
}

/** The open (not closed) TextDocument of `file`, if VS Code still holds one. */
function openDocument(file) {
  const key = fileKey(file);
  return vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.scheme === 'file' && fileKey(d.uri.fsPath) === key) || null;
}

function orgLabel(root) {
  try {
    return lib.readTargetOrg(root, os.homedir());
  } catch (err) {
    return null;
  }
}

function settings(root) {
  const cfg = vscode.workspace.getConfiguration('virga.scratch', root ? vscode.Uri.file(root) : undefined);
  const num = (key, def, min) => {
    const v = Number(cfg.get(key, def));
    return Number.isFinite(v) && v >= min ? v : def;
  };
  return {
    timeoutMs: Math.min(num('timeoutSeconds', 120, 1), 86400) * 1000, // the setting's maximum; setTimeout overflows past ~24.8 days
    maxColumnWidth: num('maxColumnWidth', 40, 4),
    clearOutputOnRun: cfg.get('clearOutputOnRun', true) !== false,
  };
}

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

function refreshStatusBar() {
  if (!state || state.disposed) return;
  const roots = sfdxRoots();
  const { apexItem, soqlItem } = state;
  if (!roots.length) {
    apexItem.hide();
    soqlItem.hide();
    state.itemsVisible = false;
    return;
  }
  const org = orgLabel(roots[0]) || 'the default org';
  apexItem.tooltip = `New anonymous Apex scratch. Ctrl+S runs it in ${org}; closing the tab discards it.`;
  soqlItem.tooltip = `New SOQL scratch. Ctrl+S runs the query in ${org}; closing the tab discards it.`;
  apexItem.show();
  soqlItem.show();
  state.itemsVisible = true;
}

// ---------------------------------------------------------------------------
// creating scratches
// ---------------------------------------------------------------------------

function pickRoot() {
  const roots = sfdxRoots();
  if (!roots.length) return null;
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (folder && roots.some((r) => lib.samePath(r, folder.uri.fsPath))) return folder.uri.fsPath;
  }
  return roots[0];
}

async function newScratch(kind) {
  try {
    const root = pickRoot();
    if (!root) {
      vscode.window.showWarningMessage('Virga: open a Salesforce DX project (folder with sfdx-project.json) first.');
      return undefined;
    }
    const dir = lib.scratchDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const names = [];
    try {
      names.push(...fs.readdirSync(dir));
    } catch (err) {
      // empty
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' && lib.isScratchFile(doc.uri.fsPath, dir)) names.push(path.basename(doc.uri.fsPath));
    }
    const org = orgLabel(root);
    const init = lib.initialContent(kind, org);
    let n = lib.nextScratchNumber(kind, names, state.counters[kind]);
    let file = null;
    for (let attempt = 0; attempt < 50 && !file; attempt += 1, n += 1) {
      const candidate = path.join(dir, lib.scratchFileName(kind, n));
      try {
        fs.writeFileSync(candidate, lib.toLf(init.text), { encoding: 'utf8', flag: 'wx' });
        file = candidate;
        state.counters[kind] = n;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (!file) throw new Error(`could not create a scratch file in ${dir}`);

    const key = fileKey(file);
    state.creating.add(key);
    state.accepted.add(key);
    try {
      const uri = vscode.Uri.file(file);
      let doc = await vscode.workspace.openTextDocument(uri);
      let editor = await vscode.window.showTextDocument(doc, { preview: false });
      // The language matters twice: the Apex / SOQL language servers pick the
      // document by it, and so does the auto save that package.json sets for it.
      const language = lib.KINDS[kind].language;
      if (doc.languageId !== language && (await vscode.languages.getLanguages()).includes(language)) {
        doc = await vscode.languages.setTextDocumentLanguage(doc, language);
        editor = await vscode.window.showTextDocument(doc, { preview: false });
      }
      const [l1, c1, l2, c2] = init.selection;
      editor.selection = new vscode.Selection(l1, c1, l2, c2);
      editor.revealRange(editor.selection);
      updateClaims();
      hintExtensionPack(kind);
      return uri;
    } finally {
      state.creating.delete(key);
    }
  } catch (err) {
    reportError(err);
    vscode.window.showErrorMessage(`Virga: ${err && err.message ? err.message : err}`);
    return undefined;
  }
}

/**
 * The first scratch of a kind whose language extension (Salesforce Extension
 * Pack) is not installed: one non-modal hint, never again on this installation.
 * The scratch works without it; only highlighting and completion are missing.
 */
function hintExtensionPack(kind) {
  try {
    if (!state || state.packHintShown || !state.memento) return;
    const ext = vscode.extensions;
    if (!ext || typeof ext.getExtension !== 'function' || ext.getExtension(LANGUAGE_EXTENSIONS[kind])) return;
    if (state.memento.get(PACK_HINT_KEY)) return;
    state.packHintShown = true;
    Promise.resolve(state.memento.update(PACK_HINT_KEY, true)).catch(() => {});
    const show = 'Show Extension Pack';
    Promise.resolve(vscode.window.showInformationMessage(
      `Virga: ${lib.KINDS[kind].label} highlighting and completion come from the Salesforce Extension Pack, which is not installed. Running with Ctrl+S needs only the Salesforce CLI.`,
      show,
    )).then((pick) => {
      if (pick === show) return vscode.commands.executeCommand('workbench.extensions.search', `@id:${EXTENSION_PACK}`);
      return undefined;
    }).catch(() => {});
  } catch (err) {
    // a hint is never worth an error
  }
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------
//
// A scratch is never "saved" by the user. package.json gives apex-anon and soql
// a short auto save (afterDelay, 100 ms) as language defaults, and for such a
// file VS Code itself writes every change in the background, shows no dirty
// dot and closes the tab without asking (it counts the document as "being
// saved"). No save runs anything: only virga.scratch.run does (Ctrl+S in the
// scratch, the editor title button, the command palette), so Save All from
// another file, auto save or File > Save cannot execute a half-written script.
//
// A run never saves either. It takes the editor text at the moment of the
// command and hands sf a temporary copy (lib.writeRunFile): keys typed after
// Ctrl+S are not part of it, no save participant (format on save, trimming
// whitespace) ever runs because of it, and it does not matter what the
// background save has or has not written yet.

/**
 * VS Code's auto save delay for `doc` when it is a short "afterDelay" one
 * (what package.json sets for the scratch languages), else null: the user
 * turned it off or lengthened it for the language.
 */
function autoSaveDelay(doc) {
  const files = vscode.workspace.getConfiguration('files', doc);
  if (files.get('autoSave') !== 'afterDelay') return null;
  const d = Number(files.get('autoSaveDelay'));
  const delay = Number.isFinite(d) && d >= 0 ? d : 1000;
  return delay <= SHORT_AUTO_SAVE_MAX_MS ? delay : null;
}

function runCommand(uri) {
  try {
    let doc = null;
    if (uri && uri.scheme) doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) || null;
    if (!doc && vscode.window.activeTextEditor) doc = vscode.window.activeTextEditor.document;
    if (!doc || !isScratchUri(doc.uri)) {
      vscode.window.showInformationMessage('Virga: this runs scratch files only. Create one with "$(play) Apex" or "$(database) SOQL" in the status bar.');
      return;
    }
    enqueue(doc.uri.fsPath, doc.getText()); // the text shown right now, not what is on disk
  } catch (err) {
    reportError(err);
  }
}

function enqueue(file, text) {
  if (!state || state.disposed) return;
  const key = fileKey(file);
  const queued = state.queue.find((job) => fileKey(job.file) === key);
  if (queued) {
    queued.text = text; // still waiting: it runs with the newest text
    vscode.window.setStatusBarMessage(`$(clock) Virga: ${path.basename(file)} is already queued, it will run this text`, 3000);
    return;
  }
  state.queue.push({ file, text });
  if (state.running) {
    state.stats.queued += 1;
    vscode.window.setStatusBarMessage(`$(clock) Virga: ${path.basename(file)} queued, runs after the current one`, 4000);
  }
  pump();
}

function pump() {
  if (!state || state.disposed || state.running) return;
  const job = state.queue.shift();
  if (!job) {
    const waiters = state.idleWaiters.splice(0);
    waiters.forEach((w) => w());
    return;
  }
  runOne(job)
    .catch((err) => reportError(err))
    .finally(() => {
      if (!state) return;
      if (state.running && state.running.runFile) lib.removeRunFile(state.running.runFile);
      state.running = null;
      state.stats.active -= 1;
      state.runningItem.hide();
      pump();
    });
}

function whenIdle() {
  if (!state || (!state.running && !state.queue.length)) return Promise.resolve();
  return new Promise((resolve) => state.idleWaiters.push(resolve));
}

async function runOne({ file, text }) {
  state.running = { file, handle: null, runFile: null };
  state.stats.active += 1;
  state.stats.maxActive = Math.max(state.stats.maxActive, state.stats.active);
  const root = scratchRootOf(file);
  if (!root) return; // its project left the workspace while it waited
  state.stats.runs += 1;
  const kind = lib.scratchKind(file);
  const cfg = settings(root);
  const org = orgLabel(root);
  const started = new Date();
  const before = cfg.clearOutputOnRun ? '' : (state.outputText ? `${state.outputText}\n` : '');

  state.runningItem.text = `$(sync~spin) Running ${lib.KINDS[kind].label}...`;
  state.runningItem.tooltip = `${path.basename(file)} in ${org || 'the default org'}`;
  state.runningItem.show();
  writeOutput(before, `${lib.formatHeader(kind, org, started)}\n  running…\n`);
  state.output.show(true);

  let runFile;
  try {
    runFile = lib.writeRunFile(file, text);
  } catch (err) {
    writeOutput(before, `${lib.formatHeader(kind, org, started)}\n✖ Could not write the scratch text to a temporary file for sf: ${err && err.message ? err.message : err}\n`);
    return;
  }
  state.running.runFile = runFile;
  state.stats.lastRunFile = runFile;
  const result = await lib.runScratch(runFile, {
    cwd: root,
    targetOrg: org, // passed to sf as --target-org: the header names the org that runs it
    source: text, // compile errors and exceptions point into this text
    timeoutMs: cfg.timeoutMs,
    maxColumnWidth: cfg.maxColumnWidth,
    onStart: (handle) => {
      if (state && state.running) state.running.handle = handle;
    },
  });
  if (!state || state.disposed) return;
  const block = [lib.formatHeader(kind, org, started, result.ms), ...result.lines].join('\n');
  writeOutput(before, `${block}\n`);
}

// ---------------------------------------------------------------------------
// a background save that failed
// ---------------------------------------------------------------------------
//
// One failed auto save (another program holding the file, a read-only flag, a
// full disk) puts VS Code's model in an error state: VS Code shows its "failed
// to save" notification, the scratch shows the dirty dot, closing it asks to
// save, and VS Code tries again only after the next edit. So when a scratch is
// still dirty SAVE_RETRY_AFTER_MS after its auto save was due, with no edit
// since, the extension saves it, as long as VS Code's auto save is on for the
// language (if the user turned it off, the dirty state is theirs to keep).
// While another program keeps the file locked no save is attempted (it would
// only fail again and renew the notification); the save that succeeds closes
// the notification too (TextFileSaveErrorHandler.onFileSavedOrReverted).

function onDocumentChanged(e) {
  const doc = e && e.document;
  if (!doc || doc.uri.scheme !== 'file' || !lib.scratchKind(doc.uri.fsPath) || !isScratchUri(doc.uri)) return;
  watchSave(doc, e.contentChanges.length > 0);
}

function stopSaveWatch(key) {
  const w = state.saveWatch.get(key);
  if (!w) return;
  clearTimeout(w.timer);
  state.saveWatch.delete(key);
}

/** (Re)starts the wait for `doc`'s auto save; `edited`: the text changed (not just the dirty flag). */
function watchSave(doc, edited) {
  if (!state || state.disposed) return;
  const key = fileKey(doc.uri.fsPath);
  if (doc.isClosed || !doc.isDirty) {
    stopSaveWatch(key);
    return;
  }
  if (state.saveWatch.has(key) && !edited) return;
  const delay = autoSaveDelay(doc);
  stopSaveWatch(key);
  if (delay === null) return;
  const entry = { timer: null, attempt: 0 };
  entry.timer = setTimeout(() => guard(() => retrySave(doc, key, entry)), delay + SAVE_RETRY_AFTER_MS);
  state.saveWatch.set(key, entry);
}

/** True unless another program holds `file` open without sharing it (the next write would fail too). */
function writable(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r+');
    return true;
  } catch (err) {
    return err.code === 'ENOENT'; // deleted behind VS Code's back: saving brings it back for the open tab
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

async function retrySave(doc, key, entry) {
  if (!state || state.disposed || state.saveWatch.get(key) !== entry) return;
  if (doc.isClosed || !doc.isDirty || autoSaveDelay(doc) === null) {
    state.saveWatch.delete(key);
    return;
  }
  entry.attempt += 1;
  if (writable(doc.uri.fsPath)) {
    state.stats.saveRetries += 1;
    try {
      await doc.save();
    } catch (err) {
      // still dirty: the next attempt follows
    }
  } else {
    state.stats.saveRetriesSkipped += 1;
  }
  if (!state || state.disposed || state.saveWatch.get(key) !== entry) return; // an edit restarted the wait
  if (doc.isClosed || !doc.isDirty) {
    state.saveWatch.delete(key);
    return;
  }
  const pause = Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_AFTER_MS * 2 ** entry.attempt);
  entry.timer = setTimeout(() => guard(() => retrySave(doc, key, entry)), pause);
}

// ---------------------------------------------------------------------------
// closing -> deleting
// ---------------------------------------------------------------------------

function onTabsChanged(e) {
  const scratchFiles = (tabs) => (tabs || []).flatMap((tab) => tabUris(tab)).filter((uri) => isScratchUri(uri)).map((uri) => uri.fsPath);
  const opened = scratchFiles(e.opened);
  const closed = scratchFiles(e.closed);
  for (const file of closed) scheduleDelete(file, DELETE_DELAY_MS);
  for (const file of opened) cancelDiscard(file); // opened again (Reopen Closed Editor) within its grace period
  if (opened.length) reconcileTabs(); // a restored tab that came late, or a scratch reopened after its file went
  if (opened.length || closed.length) updateClaims();
}

/**
 * Writes this window's owner file in every scratch folder (lib.writeClaims):
 * the scratches it keeps, that is, those its tabs show that it has accepted
 * (never one whose restored tab it is closing at startup), and during the
 * startup phase also those its previous host kept, until their tabs arrive.
 */
function updateClaims() {
  if (!state || state.disposed) return;
  const open = openTabKeys();
  const workspace = workspaceId();
  for (const root of sfdxRoots()) {
    const dir = lib.scratchDir(root);
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => {
        const file = path.join(dir, n);
        if (!lib.isScratchFile(file, dir)) return false;
        const key = fileKey(file);
        if (state.closing.has(key) || state.discards.has(key)) return false;
        if (open.has(key)) return state.accepted.has(key);
        return state.startup && state.inherited.has(key) && !state.pendingDeletes.has(key);
      });
    } catch (err) {
      names = [];
    }
    lib.writeClaims(dir, names, process.pid, state.host, workspace);
    if (!names.length) lib.removeDirIfEmpty(dir);
  }
  watchMissing();
}

function claimedBy(file, roles) {
  const claims = lib.claimedNames(owners(path.dirname(file)), roles);
  return claims.has('*') || claims.has(path.basename(file).toLowerCase());
}

/** True when another live VS Code window shows this scratch in a tab. */
function shownElsewhere(file) {
  return claimedBy(file, ['live']);
}

/**
 * True when another window still needs this scratch's file: a live one shows
 * it, or one that ended (a reload in progress, a window of another workspace
 * whose tabs come back with it) kept it.
 */
function heldElsewhere(file) {
  return claimedBy(file, ['live', 'parked']);
}

// ---------------------------------------------------------------------------
// scratch tabs that must not stay
// ---------------------------------------------------------------------------
//
// VS Code restores the editor tabs of the last session before any extension
// runs, scratch tabs included. A scratch belongs to the window that made it
// and ends with it: closing the window keeps the files (and its owner file)
// only so that a restored tab never points at nothing before this extension
// gets to it. At startup every scratch tab this window did not create is
// closed (its file is discarded with it, as for any closed scratch) unless
// another live window shows that scratch, or this same window kept it before a
// reload or an extension host restart. The file of a closed restored scratch
// stays while a window of another workspace that ended also kept it (that
// workspace restores its own tab later). A scratch tab whose file is gone
// (deleted by another program, or before VS Code restored the tab) is closed
// at any time: other extensions would otherwise act on a file that does not
// exist (Salesforce Code Analyzer reports "Analysis failed: The file or
// folder ... does not exist"). Nothing here ever asks: a tab VS Code would
// ask about (unsaved text, auto save turned off by the user) is left open.

function startupTabs() {
  state.inherited = new Set();
  for (const root of sfdxRoots()) {
    const dir = lib.scratchDir(root);
    // This window's own owner file, left by its previous extension host (the name stays across a reload).
    const own = lib.readOwnerFile(path.join(dir, lib.ownerFileName(state.host, process.pid)));
    const kept = own && own.files ? [...own.files] : [];
    for (const o of owners(dir)) if (o.role === 'previous' && o.files) kept.push(...o.files); // one without a window name (remote host)
    for (const name of kept) {
      const file = path.join(dir, name);
      if (lib.isScratchFile(file, dir)) state.inherited.add(fileKey(file));
    }
  }
  reconcileTabs();
}

/**
 * End of the startup phase (CLEANUP_DELAY_MS after activation): from now on a
 * scratch tab that shows up is one the user opened. The owner files this
 * window took over (its previous host's, and those of the windows of this
 * workspace that ended) are removed after its own claims are written, and the
 * scratches they listed that no tab here shows are discarded, unless another
 * window still needs them. Then the leftover sweep.
 */
function endStartup() {
  if (!state || state.disposed) return;
  state.startup = false;
  updateClaims();
  const orphans = new Set(state.inherited);
  for (const root of sfdxRoots()) {
    const dir = lib.scratchDir(root);
    for (const o of owners(dir)) {
      if (o.role !== 'previous' && o.role !== 'heir') continue;
      try {
        fs.unlinkSync(o.file);
      } catch (err) {
        // removed by someone else
      }
      for (const name of o.files || []) {
        const file = path.join(dir, name);
        if (lib.isScratchFile(file, dir)) orphans.add(fileKey(file));
      }
    }
  }
  const open = openTabKeys();
  for (const key of orphans) {
    if (open.has(key) || state.pendingDeletes.has(key) || state.discards.has(key)) continue;
    if (fileGone(key)) continue;
    deleteScratchNow(key, open);
  }
  cleanupLeftovers(); // closes the tabs of any file it removed, too
  lib.sweepRunDirs();
}

/** Every tab showing a scratch: [{ tab, files }]. */
function scratchTabs() {
  const list = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const files = tabUris(tab).filter((uri) => isScratchUri(uri)).map((uri) => uri.fsPath);
      if (files.length) list.push({ tab, files });
    }
  }
  return list;
}

/** True only when `file` is not there; a file another program holds locked (EBUSY, EPERM) still is. */
function fileGone(file) {
  try {
    fs.statSync(file);
    return false;
  } catch (err) {
    return err.code === 'ENOENT' || err.code === 'ENOTDIR';
  }
}

/** VS Code closes `tab` without asking: nothing in it is unsaved, or its auto save is the short one ("being saved"). */
function closesSilently(tab) {
  return tabUris(tab).every((uri) => {
    const doc = openDocument(uri.fsPath);
    return !doc || !doc.isDirty || autoSaveDelay(doc) !== null;
  });
}

/** Closes the scratch tabs that must not stay (see above); keeps every other one. */
function reconcileTabs(attempt = 0) {
  if (!state || state.disposed) return;
  const doomed = [];
  let acceptedNew = false;
  for (const { tab, files } of scratchTabs()) {
    const keys = files.map(fileKey);
    if (keys.some((k) => state.closing.has(k))) continue;
    let reason = null;
    if (files.some(fileGone)) {
      reason = 'missing';
    } else if (state.startup) {
      const unknown = files.filter((f) => !state.accepted.has(fileKey(f)) && !state.creating.has(fileKey(f)));
      if (unknown.length) {
        if (unknown.every((f) => state.inherited.has(fileKey(f)) || shownElsewhere(f))) {
          for (const f of unknown) state.stats.tabsKeptRestored.push(path.basename(f));
        } else {
          reason = 'restored';
        }
      }
    }
    if (reason && !closesSilently(tab)) {
      if (reason === 'missing') continue; // VS Code shows it as deleted; asking is worse
      reason = null; // restored with unsaved text and no auto save: kept rather than asked about
      for (const f of files) state.stats.tabsKeptRestored.push(path.basename(f));
    }
    if (!reason) {
      for (const k of keys) {
        if (!state.accepted.has(k)) acceptedNew = true;
        state.accepted.add(k);
      }
      continue;
    }
    doomed.push({ tab, files, keys, reason });
  }
  if (acceptedNew) updateClaims(); // this window keeps them now
  if (!doomed.length) return;
  for (const d of doomed) d.keys.forEach((k) => state.closing.add(k));
  let request;
  try {
    // One call for all of them: closing one by one would bring the next restored scratch to the front.
    request = Promise.resolve(vscode.window.tabGroups.close(doomed.map((d) => d.tab), true));
  } catch (err) {
    request = Promise.reject(err);
  }
  request
    .then((closed) => closed !== false, () => false) // a tab object went stale: the tab model was replaced meanwhile
    .then((closed) => {
      if (!state) return;
      for (const d of doomed) d.keys.forEach((k) => state.closing.delete(k));
      if (closed) {
        for (const d of doomed) {
          const list = d.reason === 'missing' ? state.stats.tabsClosedMissing : state.stats.tabsClosedRestored;
          for (const f of d.files) list.push(path.basename(f));
        }
      } else if (attempt < CLOSE_RETRIES && !state.disposed) {
        setTimeout(() => guard(() => reconcileTabs(attempt + 1)), 50);
      }
    });
}

/** Keeps the file check running exactly while a scratch tab is open. */
function watchMissing() {
  if (!state || state.disposed) return;
  const any = scratchTabs().length > 0;
  if (any && !state.missingTimer) state.missingTimer = setInterval(() => guard(checkMissing), MISSING_CHECK_MS);
  if (!any && state.missingTimer) {
    clearInterval(state.missingTimer);
    state.missingTimer = null;
  }
}

/** A scratch file gone while its tab is open: closed once it is still gone a moment later. */
function checkMissing() {
  if (!state || state.disposed || state.missingConfirm) return;
  const files = scratchTabs().flatMap((t) => t.files);
  if (!files.length) {
    watchMissing();
    return;
  }
  if (!files.some(fileGone)) return;
  state.missingConfirm = setTimeout(() => {
    if (!state) return;
    state.missingConfirm = null;
    guard(() => reconcileTabs());
  }, MISSING_CONFIRM_MS);
}

function onDocumentClosed(doc) {
  if (!doc || !isScratchUri(doc.uri)) return;
  stopSaveWatch(fileKey(doc.uri.fsPath));
  scheduleDelete(doc.uri.fsPath, DELETE_DELAY_MS);
}

function scheduleDelete(file, delay, tries = 0) {
  if (!state) return;
  const key = fileKey(file);
  const existing = state.pendingDeletes.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    state.pendingDeletes.delete(key);
    guard(() => deleteScratchNow(file, null, tries));
  }, delay);
  state.pendingDeletes.set(key, { timer, file });
}

/**
 * Discards one scratch unless a tab still shows it (in this window:
 * `openKeys`) or another window still needs it (heldElsewhere). Called from
 * the delayed delete and, with the tab state taken just before, from
 * shutdown(). A run still waiting for it goes with it; a run already going
 * reads its own copy, never this file.
 */
function deleteScratchNow(file, openKeys, tries = 0) {
  try {
    const key = fileKey(file);
    if (state && state.creating.has(key)) return;
    const root = scratchRootOf(file);
    if (!root) return; // never outside a project's scratch folder
    const open = openKeys || openTabKeys();
    if (open.has(key)) return; // still shown in this window
    if (state) state.queue = state.queue.filter((job) => fileKey(job.file) !== key); // its tab is closed here: a waiting run goes
    if (heldElsewhere(file)) return; // another window shows it, or will restore it
    const doc = state && !state.disposed ? openDocument(file) : null;
    if (doc && doc.isDirty && tries < DELETE_MAX_RETRIES) {
      // Closed within the auto save delay: VS Code closed the tab without asking
      // and writes the text a moment later. Deleting first would let that write
      // bring the file back.
      state.stats.deferredDeletes += 1;
      scheduleDelete(file, DELETE_RETRY_MS, tries + 1);
      return;
    }
    discard(file);
  } catch (err) {
    // deleting is best effort
  }
}

/**
 * The scratch is gone for the user (its tab closed, its waiting run dropped).
 * Its file goes when the grace period is over, or right away while the window
 * shuts down: an extension that started on it while it was open still finds it.
 * Until then no window claims it, and opening it again makes it a scratch again.
 */
function discard(file) {
  if (!state) return;
  const key = fileKey(file);
  cancelDiscard(file);
  if (state.disposed || !(state.discardGraceMs > 0) || fileGone(file)) {
    unlinkScratch(file);
    return;
  }
  const entry = { file, at: Date.now(), timer: null };
  entry.timer = setTimeout(() => guard(() => endGrace(key, entry)), state.discardGraceMs);
  state.discards.set(key, entry);
  updateClaims();
}

function endGrace(key, entry) {
  if (!state || state.discards.get(key) !== entry) return;
  state.discards.delete(key);
  finishDiscard(entry.file, null);
}

/** The grace period of a discarded scratch is over: its file goes unless it is shown or needed again. */
function finishDiscard(file, openKeys) {
  const open = openKeys || openTabKeys();
  if (open.has(fileKey(file))) return; // opened again (Reopen Closed Editor): a scratch again
  if (heldElsewhere(file)) return;
  unlinkScratch(file);
}

/** A discarded scratch opened again: it stays. */
function cancelDiscard(file) {
  if (!state) return;
  const key = fileKey(file);
  const entry = state.discards.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  state.discards.delete(key);
}

function unlinkScratch(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    // already gone or locked: nothing to do
  }
  if (state && !state.disposed) updateClaims();
  lib.removeDirIfEmpty(path.dirname(file)); // only succeeds when the folder is empty
}

/** Test hook: a new grace period, also for the scratches already waiting (counted from their discard). */
function setDiscardGraceMs(ms) {
  if (!state) return;
  state.discardGraceMs = Number(ms) || 0;
  for (const [key, entry] of state.discards) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => guard(() => endGrace(key, entry)), Math.max(0, entry.at + state.discardGraceMs - Date.now()));
  }
}

/**
 * Crash recovery: scratch files older than a few minutes that no window needs
 * (no tab here, no claim of a live window or of a window that ended and may
 * come back, see lib.ownerRole). Owner files nothing comes back for go too.
 */
function cleanupLeftovers(maxAgeMs = LEFTOVER_AGE_MS) {
  if (!state || state.disposed) return [];
  const removed = [];
  const open = openTabKeys();
  for (const root of sfdxRoots()) {
    const dir = lib.scratchDir(root);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      continue;
    }
    const all = owners(dir);
    for (const o of all) {
      if (o.role !== 'gone') continue;
      try {
        fs.unlinkSync(o.file);
      } catch (err) {
        // another window removed it first
      }
    }
    const claims = lib.claimedNames(all, ['live', 'parked']);
    for (const name of names) {
      const file = path.join(dir, name);
      const key = fileKey(file);
      if (!lib.isScratchFile(file, dir) || open.has(key) || state.pendingDeletes.has(key) || state.discards.has(key)) continue;
      if (claims.has('*') || claims.has(name.toLowerCase())) continue;
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || Date.now() - st.mtimeMs < maxAgeMs) continue;
        fs.unlinkSync(file);
        removed.push(file);
      } catch (err) {
        // leave it
      }
    }
    updateClaims();
    lib.removeDirIfEmpty(dir);
  }
  reconcileTabs(); // no tab may stay on a file that is gone
  return removed;
}

module.exports = { activate, deactivate };
