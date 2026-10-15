// Runs inside the isolated VS Code (see ../run-e2e.mjs). Drives the extension
// the way a user does: typed text and key presses (Ctrl+S, Ctrl+F4, Ctrl+W)
// go in through the Chrome DevTools protocol, which run-e2e.mjs plays on
// request (ipc/input-<n>.json), so the real keymap decides what they do.
// Results go to VIRGA_E2E_OUT. Every native dialog is logged by
// dialog-watch.ps1 (VIRGA_E2E_DIALOGS) and dismissed, so a "save
// changes?" question fails a check instead of hanging the run.
//
// VIRGA_E2E_MODE: "main" (default keymap, everything) or "intellij"
// (IntelliJ IDEA keymap, where Ctrl+S is Save All: the key checks only).
// Both end by closing the window right after typing into a scratch.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.VIRGA_E2E_OUT || path.join(__dirname, '..', 'e2e-out.json');
// The org the runs go to (run-e2e.mjs writes it as the project's target-org).
const ORG = process.env.VIRGA_TEST_ORG || '';
const ORG_RE = ORG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MODE = process.env.VIRGA_E2E_MODE || 'main';
const IPC = process.env.VIRGA_E2E_IPC;
const DIALOGS = process.env.VIRGA_E2E_DIALOGS;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
const note = (name, detail) => results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });

async function waitFor(fn, timeout = 30000, every = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      // retry
    }
    await sleep(every);
  }
  return null;
}

async function step(name, fn) {
  const d0 = dialogCount();
  try {
    await fn();
  } catch (err) {
    results.push({ name: `${name} (threw)`, ok: false, detail: String((err && err.stack) || err) });
  }
  const d1 = dialogCount();
  if (d1 > d0) results.push({ name: `${name}: no dialog during this step`, ok: false, detail: `${d1 - d0} dialog(s), see ${DIALOGS}` });
}

/** Resolves { done: true, value } or, after `ms`, { done: false }: a modal that blocks never hangs the run. */
function withTimeout(promise, ms) {
  return Promise.race([promise.then((value) => ({ done: true, value })), sleep(ms).then(() => ({ done: false }))]);
}

let api;
let ws;
let dir;
let defaultGrace; // how long a discarded scratch's file stays outside the tests

const exists = (p) => fs.existsSync(p);
const allTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
const tabsFor = (file) => allTabs().filter((t) => t.input && t.input.uri && t.input.uri.fsPath.toLowerCase() === file.toLowerCase());
const docOf = (file) => vscode.workspace.textDocuments.find((d) => d.uri.fsPath.toLowerCase() === file.toLowerCase());

async function setText(editor, text) {
  const doc = editor.document;
  await editor.edit((eb) => eb.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
}

async function focus(file) {
  return vscode.window.showTextDocument(docOf(file), { preview: false });
}

/** Cursor to the end of the document (typed text lands there). */
function cursorToEnd(editor) {
  const end = editor.document.positionAt(editor.document.getText().length);
  editor.selection = new vscode.Selection(end, end);
}

// --- keyboard through CDP -----------------------------------------------------

let inputSeq = 0;
/** Plays [{text}|{key}|{waitMs}|{evaluate}] through the DevTools protocol; resolves { ok, times, values }. */
async function input(steps) {
  inputSeq += 1;
  const req = path.join(IPC, `input-${inputSeq}.json`);
  fs.writeFileSync(`${req}.tmp`, JSON.stringify({ steps }));
  fs.renameSync(`${req}.tmp`, req);
  const resFile = path.join(IPC, `inputres-${inputSeq}.json`);
  const res = await waitFor(() => (fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : null), 30000, 5);
  if (!res) throw new Error(`input ${inputSeq}: no answer from run-e2e.mjs`);
  if (!res.ok) throw new Error(`input ${inputSeq}: ${res.error}`);
  return res;
}
const typing = (text, gapMs = 0) => [...text].flatMap((ch) => (gapMs ? [{ text: ch }, { waitMs: gapMs }] : [{ text: ch }]));

function dialogCount() {
  try {
    return fs.readFileSync(DIALOGS, 'utf8').split('\n').filter(Boolean).length;
  } catch (err) {
    return 0;
  }
}

// Counts every moment a tab carries VS Code's dirty marker (class "dirty": the
// dot instead of the close button) while it runs in the workbench page.
const DOT_WATCH_START = `(() => {
  const st = window.__virgaDots = { appeared: 0, seenDirtyNow: 0, names: [] };
  const dirtyTabs = () => [...document.querySelectorAll('.tabs-container .tab.dirty')];
  const record = () => {
    const d = dirtyTabs();
    if (d.length) { st.appeared += 1; for (const t of d) { const n = t.getAttribute('aria-label') || t.textContent; if (!st.names.includes(n)) st.names.push(n); } }
  };
  record();
  st.mo = new MutationObserver(record);
  st.mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  return true;
})()`;
const DOT_WATCH_READ = `(() => { const s = window.__virgaDots; s.mo.disconnect(); return { appeared: s.appeared, dirtyNow: document.querySelectorAll('.tabs-container .tab.dirty').length, names: s.names }; })()`;
const DIRTY_TABS = "document.querySelectorAll('.tabs-container .tab.dirty').length";
// Notification toasts on screen that are about a failed save.
const SAVE_ERROR_TOASTS = "[...document.querySelectorAll('.notifications-toasts .notification-list-item')].map((n) => n.textContent).filter((t) => /save/i.test(t))";

/** Another program opens `file` without sharing (FileShare.None) for `ms`; `ready` resolves once it holds the lock. */
function lockFile(file, ms) {
  const marker = path.join(IPC, `lock-${Date.now()}.ok`);
  const q = (s) => s.replace(/'/g, "''");
  const script = `$f = [System.IO.File]::Open('${q(file)}', 'Open', 'ReadWrite', 'None'); New-Item -ItemType File '${q(marker)}' | Out-Null; Start-Sleep -Milliseconds ${ms}; $f.Close()`;
  const p = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
  const done = new Promise((resolve) => p.on('exit', resolve));
  const ready = waitFor(() => exists(marker), 20000, 10);
  return { ready, done };
}

/** The temporary copy of the last run: in the temp folder, not the scratch, and gone once the run is over. */
function runCopyChecks(prefix, scratchFile) {
  const runFile = api.stats().lastRunFile;
  const inTmp = !!runFile && path.dirname(path.dirname(runFile)).toLowerCase() === os.tmpdir().toLowerCase() && /^virga-run-\d+-/.test(path.basename(path.dirname(runFile)));
  check(`${prefix}sf ran a temporary copy of the text, not the scratch file, and the copy is gone`, inTmp && runFile.toLowerCase() !== scratchFile.toLowerCase() && !exists(path.dirname(runFile)), { runFile, tmp: os.tmpdir() });
}

// --- runs -----------------------------------------------------------------------

/** Triggers a run and waits until it is finished; returns the channel text and how many runs it caused. */
async function runAndWait(trigger, expectRuns = 1) {
  const before = api.stats().runs;
  await trigger();
  const started = await waitFor(() => api.stats().runs >= before + 1, 8000, 25);
  if (!started) return { started: false, text: api.outputText(), runs: api.stats().runs - before };
  await waitFor(async () => {
    await api.whenIdle();
    await sleep(300);
    return api.stats().runs >= before + expectRuns && !api.stats().running && api.stats().queueLength === 0;
  }, 120000, 50);
  await sleep(1000); // anything that would start a second run has had its chance
  await api.whenIdle();
  return { started: true, text: api.outputText(), runs: api.stats().runs - before };
}

const runCommand = () => vscode.commands.executeCommand('virga.scratch.run');

function outputDocument() {
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'output' && /apex.?scratch/i.test(decodeURIComponent(d.uri.toString())));
}

let notesSeq = 0;
/**
 * A dirty plain-text file next to the project (no auto save for plaintext: it
 * stays dirty). Every call gets a new name: VS Code may still hold the model of
 * a file this suite deleted, and would refuse to save over a recreated one.
 */
async function dirtyNotes(name) {
  notesSeq += 1;
  const file = path.join(ws, name || `notes-${notesSeq}.txt`);
  fs.writeFileSync(file, 'notes\n');
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false });
  await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), 'x'));
  return { file, editor };
}

async function closeAndRemove(file) {
  const tabs = tabsFor(file);
  if (tabs.length) await withTimeout(vscode.window.tabGroups.close(tabs), 8000);
  fs.rmSync(file, { force: true });
}

// ---------------------------------------------------------------------------
// shared steps
// ---------------------------------------------------------------------------

/** Type, then Ctrl+S in the same instant: exactly one run, of the text as typed. */
async function ctrlSRunsOnceStep(prefix) {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const editor = vscode.window.activeTextEditor;
  await setText(editor, "System.debug('base line');\n");
  cursorToEnd(editor);
  await sleep(400); // that edit is written; what follows is typed
  const runs = api.stats().runs;
  const saves = [];
  const sub = vscode.workspace.onDidSaveTextDocument((d) => { if (d.uri.fsPath === uri.fsPath) saves.push(Date.now()); });
  const typed = `System.debug('typed then ${prefix} ctrl+s');`;
  const r = await runAndWait(() => input([...typing(typed), { key: 'ctrl+s' }]));
  sub.dispose();
  check(`${prefix}Ctrl+S in the scratch started exactly one run`, r.started && r.runs === 1, { started: r.started, runs: r.runs, statsRuns: api.stats().runs - runs });
  check(`${prefix}that run used the text as typed (the last keystroke included)`, r.text.includes(`DEBUG  typed then ${prefix} ctrl+s`) && r.text.includes('DEBUG  base line'), r.text);
  check(`${prefix}the file holds exactly the editor text, no dirty state left`, fs.readFileSync(uri.fsPath, 'utf8') === editor.document.getText() && !editor.document.isDirty);
  note(`${prefix}saves of the scratch around that run`, String(saves.length));
  return { uri, editor, r };
}

/**
 * Ctrl+S, then typing goes on for about 2 s (60 ms per key, so the auto save
 * never gets its pause). The run has the text shown at Ctrl+S and nothing
 * typed later; no save participant touches the keys typed after it (the
 * profile has files.trimTrailingWhitespace on), and the run saves nothing.
 */
async function keepTypingStep(prefix) {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const editor = vscode.window.activeTextEditor;
  await setText(editor, "System.debug('base line');\n");
  cursorToEnd(editor);
  await sleep(400);
  const before = editor.document.getText();
  const atCtrlS = "System.debug('shown at ctrl+s');";
  const after = ` System.debug('typed after ctrl+s');${' '.repeat(14)}Integer y;`;
  const reasons = [];
  const sub = vscode.workspace.onWillSaveTextDocument((e) => { if (e.document.uri.fsPath === uri.fsPath) reasons.push(e.reason); });
  const r = await runAndWait(() => input([...typing(atCtrlS), { key: 'ctrl+s' }, ...typing(after, 60)]));
  await waitFor(() => !editor.document.isDirty, 3000, 20);
  sub.dispose();
  check(`${prefix}(4) Ctrl+S then typing on: exactly one run`, r.started && r.runs === 1, { started: r.started, runs: r.runs });
  check(`${prefix}(4) that run had the text shown at Ctrl+S and nothing typed after it`, r.text.includes('✔ Compiled  ✔ Executed') && r.text.includes('DEBUG  shown at ctrl+s') && r.text.includes('DEBUG  base line') && !r.text.includes('typed after ctrl+s'), r.text);
  check(`${prefix}(4) every key typed after Ctrl+S is still in the editor, the 14 spaces too (no save participant trimmed them)`, editor.document.getText() === before + atCtrlS + after, { doc: JSON.stringify(editor.document.getText().slice(before.length)) });
  check(`${prefix}(4) the scratch was written by auto saves only, never by an explicit save of the run`, reasons.length >= 1 && reasons.every((x) => x === vscode.TextDocumentSaveReason.AfterDelay), reasons);
  check(`${prefix}(4) and the file holds the whole text`, fs.readFileSync(uri.fsPath, 'utf8') === editor.document.getText());
  runCopyChecks(`${prefix}(4) `, uri.fsPath);
  await withTimeout(vscode.window.tabGroups.close(tabsFor(uri.fsPath)), 8000);
  check(`${prefix}(4) scratch deleted after closing`, await waitFor(() => !exists(uri.fsPath), 5000, 100));
}

/** Save All pressed in another (dirty) editor while the scratch has unsaved text: the scratch never runs. */
async function saveAllElsewhereStep(prefix, pressKeys) {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const scratchDoc = docOf(uri.fsPath);
  const notes = await dirtyNotes(); // the active, focused editor from here on
  const runs = api.stats().runs;
  // Unsaved text in the (background) scratch at the moment of Save All: its 100 ms auto save has not fired yet.
  const we = new vscode.WorkspaceEdit();
  we.insert(uri, new vscode.Position(2, 0), "System.debug('must not run');\n");
  await vscode.workspace.applyEdit(we);
  const scratchDirty = scratchDoc.isDirty;
  if (pressKeys) await input([{ key: 'ctrl+s' }]); // IntelliJ keymap: Ctrl+S = Save All
  else await vscode.commands.executeCommand('workbench.action.files.saveAll');
  await sleep(2000);
  await api.whenIdle();
  check(`${prefix}Save All from another editor saved that editor`, !notes.editor.document.isDirty, notes.editor.document.isDirty);
  check(`${prefix}and ran no scratch`, api.stats().runs === runs, { runs: api.stats().runs - runs, scratchDirtyAtSaveAll: scratchDirty });
  check(`${prefix}the scratch's text is on disk anyway`, fs.readFileSync(uri.fsPath, 'utf8').includes('must not run') && !scratchDoc.isDirty);
  note(`${prefix}scratch still unsaved when Save All was pressed`, String(scratchDirty));
  await closeAndRemove(notes.file);
  await withTimeout(vscode.window.tabGroups.close(tabsFor(uri.fsPath)), 8000);
  check(`${prefix}scratch deleted after closing`, await waitFor(() => !exists(uri.fsPath), 5000, 100));
}

/** Type and close with the keyboard in the same instant: no question, tab gone, file gone for good. */
async function typeThenCloseKeyStep(prefix, key) {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  await sleep(300);
  const d0 = dialogCount();
  const runs = api.stats().runs;
  const r = await input([{ text: 'x' }, { text: 'y' }, { key }]);
  const tabGone = await waitFor(() => tabsFor(uri.fsPath).length === 0, 5000, 20);
  await sleep(1500); // a dialog would have been logged by now
  check(`${prefix}type then ${key} at once: no "save changes?" dialog`, dialogCount() === d0, { dialogs: dialogCount() - d0, times: r.times });
  check(`${prefix}type then ${key} at once: the tab closed`, tabGone);
  check(`${prefix}type then ${key} at once: file deleted`, await waitFor(() => !exists(uri.fsPath), 5000, 50));
  await sleep(800);
  check(`${prefix}type then ${key} at once: and not written back afterwards`, !exists(uri.fsPath));
  check(`${prefix}type then ${key} at once: nothing ran`, api.stats().runs === runs);
}

/**
 * A background save fails (another program holds the file without sharing
 * for 1.5 s). VS Code leaves such a document dirty and would ask on close;
 * the extension saves it once the file is free, without trying while locked.
 */
async function lockedSaveStep() {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const editor = vscode.window.activeTextEditor;
  cursorToEnd(editor);
  await sleep(500);
  const st0 = api.stats();
  const lock = lockFile(uri.fsPath, 1500);
  const held = await lock.ready;
  const d0 = dialogCount();
  await input([{ text: 'x' }]);
  await sleep(600);
  const dirtyWhileLocked = editor.document.isDirty;
  const toastsWhileLocked = (await input([{ evaluate: SAVE_ERROR_TOASTS }])).values[0];
  await lock.done;
  const t0 = Date.now();
  const clean = await waitFor(() => !editor.document.isDirty, 8000, 20);
  const msAfterUnlock = Date.now() - t0;
  await sleep(300);
  const [dots, toasts] = (await input([{ evaluate: DIRTY_TABS }, { evaluate: SAVE_ERROR_TOASTS }])).values;
  check('(1) locked file: the background save failed (VS Code alone would keep the scratch dirty from here on)', held && dirtyWhileLocked, { held: !!held, dirtyWhileLocked });
  check('(1) locked file: saved by the extension once the file was free, no dirty dot left', clean && dots === 0 && fs.readFileSync(uri.fsPath, 'utf8') === editor.document.getText(), { clean: !!clean, msAfterUnlock, dots, stats: api.stats() });
  check('(1) locked file: no save attempted while locked, exactly one once the file was free', api.stats().saveRetriesSkipped > st0.saveRetriesSkipped && api.stats().saveRetries === st0.saveRetries + 1, { before: st0, after: api.stats() });
  check('(1) locked file: no "failed to save" notification left on screen', toasts.length === 0, toasts);
  note('(1) locked file: ms from unlock to clean; VS Code\'s own notifications while locked', JSON.stringify({ msAfterUnlock, toastsWhileLocked }));
  await input([{ key: 'ctrl+f4' }]);
  const tabGone = await waitFor(() => tabsFor(uri.fsPath).length === 0, 5000, 20);
  await sleep(1500);
  check('(1) locked file: Ctrl+F4 afterwards closes the tab without a save dialog', tabGone && dialogCount() === d0, { tabGone: !!tabGone, dialogs: dialogCount() - d0 });
  check('(1) locked file: and the file is deleted', await waitFor(() => !exists(uri.fsPath), 5000, 50));
}

/**
 * A run of about 6 s (a busy loop in Apex, read-only) starts, its tab is
 * closed: the scratch file goes at once, sf keeps its own copy. The window
 * closes next, while that run still goes (windowCloseStep); run-e2e.mjs then
 * checks that neither the scratch nor the copy outlived VS Code.
 */
async function closeWhileRunningStep() {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const editor = vscode.window.activeTextEditor;
  await setText(editor, "Long t0 = System.currentTimeMillis();\nwhile (System.currentTimeMillis() - t0 < 6000) { }\nSystem.debug('slow run done');\n");
  await sleep(300);
  await runCommand();
  const started = await waitFor(() => api.stats().running && api.stats().lastRunFile, 8000, 25);
  const runFile = api.stats().lastRunFile;
  const copyThere = !!runFile && exists(runFile);
  await withTimeout(vscode.window.tabGroups.close(tabsFor(uri.fsPath)), 8000);
  const gone = await waitFor(() => (!exists(uri.fsPath) ? { running: api.stats().running } : null), 5000, 10);
  check('(3) closing a scratch while its run goes on deletes the file at once (sf runs a copy)', started && copyThere && gone && gone.running, { started: !!started, copyThere, gone });
  return { closedFile: uri.fsPath, runFile };
}

/** Last step: type, close the window at once. The runner checks for dialogs, that the text reached the disk and what is left. */
async function windowCloseStep(prefix, extra = {}) {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const editor = vscode.window.activeTextEditor;
  cursorToEnd(editor);
  await sleep(300);
  const typed = "System.debug('typed right before the window closed');";
  await input(typing(typed));
  const arrived = await waitFor(() => editor.document.getText().includes(typed), 3000, 2);
  const marker = { file: uri.fsPath, text: editor.document.getText(), dirtyAtClose: editor.document.isDirty, keep: [path.basename(uri.fsPath)], runningAtClose: api.stats().running, ...extra };
  fs.writeFileSync(path.join(IPC, 'window-close.json'), JSON.stringify(marker));
  check(`window close: ${prefix}typed text reached the extension host before closing`, arrived);
  note(`window close: ${prefix}scratch still unsaved when the window was told to close`, String(marker.dirtyAtClose));
  if (extra.runFile) check(`window close: ${prefix}the run of the closed scratch was still going when the window was told to close (quitting mid-run is what gets checked)`, marker.runningAtClose, api.stats());
}

// ---------------------------------------------------------------------------
// default keymap: everything
// ---------------------------------------------------------------------------

/**
 * Next to the Extension Pack's snippets (run-e2e.mjs loads a stand-in that
 * contributes the pack's snippet files the way the pack does;
 * VIRGA_E2E_PACK_SNIPPETS describes it): each prefix typed in a class or a
 * .soql file lists its label as often as the two extensions contribute it, and
 * no label comes from both. Before the fix, `for` listed four items labelled
 * "for" (the pack's and three of Virga's).
 */
async function packSnippetsStep() {
  const infoFile = process.env.VIRGA_E2E_PACK_SNIPPETS;
  if (!infoFile) {
    note('snippets next to the Extension Pack: no stand-in loaded, skipped');
    return;
  }
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const ext = vscode.extensions.getExtension('WiktorMayska.virga');
  const own = {}; // language -> prefix -> how many Virga snippets carry it
  for (const s of ext.packageJSON.contributes.snippets) {
    const file = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, s.path), 'utf8'));
    own[s.language] = own[s.language] || Object.create(null); // prefixes such as "constructor"
    for (const sn of Object.values(file)) for (const p of [].concat(sn.prefix)) own[s.language][p] = (own[s.language][p] || 0) + 1;
  }
  const docs = {
    apex: { file: path.join(ws, 'force-app', 'main', 'default', 'classes', 'SnippetProbe.cls'), text: 'public with sharing class SnippetProbe {\n    void probe() {\n        x\n    }\n}\n', line: 2, indent: '        ' },
    soql: { file: path.join(ws, 'scripts', 'soql', 'snippet-probe.soql'), text: 'x\n', line: 0, indent: '' },
  };
  const n = (counts, w) => (Object.prototype.hasOwnProperty.call(counts, w) ? counts[w] : 0);
  const statements = ['throw', 'if', 'ifelse', 'else', 'for', 'fori', 'while', 'do', 'try', 'tryf', 'switch', 'class', 'interface', 'enum', 'dbquery'];
  for (const [language, d] of Object.entries(docs)) {
    fs.mkdirSync(path.dirname(d.file), { recursive: true });
    fs.writeFileSync(d.file, d.text);
    const doc = await vscode.workspace.openTextDocument(d.file);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const mine = own[language] || {};
    const pack = info.counts[language] || {};
    const words = [...new Set([...Object.keys(mine), ...Object.keys(pack)])].filter((w) => /^\w+$/.test(w)).sort();
    const wrong = [];
    const both = [];
    const seen = {};
    for (const w of words) {
      await editor.edit((eb) => eb.replace(doc.lineAt(d.line).range, d.indent + w));
      const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(d.line, d.indent.length + w.length));
      const count = (list && list.items ? list.items : [])
        .filter((i) => i.kind === vscode.CompletionItemKind.Snippet && (typeof i.label === 'string' ? i.label : i.label.label) === w).length;
      const expected = n(mine, w) + n(pack, w);
      seen[w] = count;
      if (count !== expected) wrong.push({ w, count, virga: n(mine, w), pack: n(pack, w) });
      if (n(mine, w) && count > n(mine, w)) both.push({ w, count, virga: n(mine, w) });
    }
    check(`snippets next to the Extension Pack (${info.source}), ${language}: ${words.length} prefixes typed, each label listed as often as Virga and the pack contribute it`, words.length > 5 && wrong.length === 0, wrong);
    check(`snippets next to the Extension Pack, ${language}: no label from both Virga and the pack (as two items with the same name)`, both.length === 0, both);
    if (language === 'apex') {
      const once = statements.filter((w) => seen[w] === 1 && !n(mine, w));
      check('snippets next to the Extension Pack, apex: the statements the pack ships (for, fori, try, tryf, class, if, ...) are listed once, as the pack\'s', once.length === statements.length, statements.map((w) => `${w}: ${seen[w]}${n(mine, w) ? ' (also Virga)' : ''}`));
      check('snippets next to the Extension Pack, apex: Virga\'s own keywords are still there (return, elseif, dbqueryuser)', ['return', 'elseif', 'dbqueryuser'].every((w) => seen[w] === 1), { return: seen.return, elseif: seen.elseif, dbqueryuser: seen.dbqueryuser });
    }
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

async function mainSuite() {
  await step('snippets next to the Extension Pack', packSnippetsStep);

  await step('status bar', async () => {
    check('status bar items visible in an SFDX workspace', api.statusBarVisible());
    const items = api.statusBar();
    check('status bar texts', items[0].text === '$(play) Apex' && items[1].text === '$(database) SOQL', items);
    check('tooltips: Ctrl+S runs in the org, closing discards', items[0].tooltip.includes(`Ctrl+S runs it in ${ORG}; closing the tab discards it`) && items[1].tooltip.includes(`Ctrl+S runs the query in ${ORG}`), items);
  });

  await step('crash leftovers', async () => {
    const gone = await waitFor(() => !exists(path.join(dir, 'scratch-7.apex')), 15000, 250);
    check('old leftover scratch-7.apex deleted at startup', gone);
    check('foreign file keep.txt in the scratch folder kept', exists(path.join(dir, 'keep.txt')));
  });

  let apexFile;
  let apexEditor;
  await step('new Apex scratch', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    apexFile = uri.fsPath;
    apexEditor = vscode.window.activeTextEditor;
    check('file is <ws>/.sfdx/virga-scratch/scratch-1.apex', apexFile.toLowerCase() === path.join(dir, 'scratch-1.apex').toLowerCase(), apexFile);
    check('file exists on disk', exists(apexFile));
    const raw = fs.readFileSync(apexFile, 'utf8');
    check('initial text with the org name and LF only', raw === `// Ctrl+S runs this in ${ORG}. Close the tab to discard.\n\n`, raw);
    check('language apex-anon', apexEditor.document.languageId === 'apex-anon', apexEditor.document.languageId);
    check('cursor on the line below the empty line', apexEditor.selection.active.line === 2 && apexEditor.selection.active.character === 0, apexEditor.selection.active);
    check('real file: uri scheme file', apexEditor.document.uri.scheme === 'file');
    const files = vscode.workspace.getConfiguration('files', apexEditor.document);
    const userLevel = vscode.workspace.getConfiguration('files').inspect('autoSave').globalValue;
    check('VS Code resolves files.autoSave = afterDelay, 100 ms for the scratch (package.json language default beats "files.autoSave": "off" in user settings)', userLevel === 'off' && files.get('autoSave') === 'afterDelay' && files.get('autoSaveDelay') === 100 && api.autoSaveDelay(apexEditor.document) === 100, { userLevel, autoSave: files.get('autoSave'), delay: files.get('autoSaveDelay') });
  });

  await step('typing: no dirty dot, written in the background, nothing runs', async () => {
    await focus(apexFile);
    cursorToEnd(apexEditor);
    const runs = api.stats().runs;
    const saves = [];
    const sub = vscode.workspace.onDidSaveTextDocument((d) => { if (d.uri.fsPath === apexFile) saves.push(Date.now()); });
    const typed = "System.debug('typed key by key');";
    // Keeps watching 400 ms past the last keystroke: through the auto save itself.
    const res = await input([{ evaluate: DOT_WATCH_START }, ...typing(typed, 30), { waitMs: 400 }, { evaluate: DOT_WATCH_READ }]);
    const dots = res.values[1];
    await sleep(300);
    const dirtyAfter300 = apexEditor.document.isDirty;
    await sleep(1200);
    sub.dispose();
    check('(a) 300 ms after the last keystroke the scratch is not dirty', !dirtyAfter300);
    check('no dirty dot on any tab while typing (renderer DOM)', dots && dots.appeared === 0 && dots.dirtyNow === 0, dots);
    check('the file holds exactly the editor text', fs.readFileSync(apexFile, 'utf8') === apexEditor.document.getText() && apexEditor.document.getText().includes(typed));
    check('(c) background saves happened and ran nothing', saves.length >= 1 && api.stats().runs === runs, { saves: saves.length, runs: api.stats().runs - runs });
    check('nothing written to the output channel by typing', api.outputText() === '', api.outputText());
    // Positive control: the same watcher does see the dot of a dirty plain-text file (no auto save there).
    const ctl = await input([{ evaluate: DOT_WATCH_START }]);
    const notes = await dirtyNotes('dot-control.txt');
    await sleep(500);
    const ctlRead = await input([{ evaluate: DOT_WATCH_READ }]);
    check('control: a dirty plain-text file shows the dot (the watcher works, auto save stays limited to apex-anon/soql)', ctl.ok && ctlRead.values[0].appeared > 0 && notes.editor.document.isDirty, ctlRead.values[0]);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await closeAndRemove(notes.file);
    apexEditor = await focus(apexFile);
  });

  // The first Ctrl+S of this window: keys typed right after it must not get into the run.
  await step('(4) Ctrl+S, then typing goes on (the first run of the session)', () => keepTypingStep(''));

  await step('(d) Ctrl+S right after typing runs anonymous Apex once, with the typed text', async () => {
    apexEditor = await focus(apexFile);
    await setText(apexEditor, "System.debug('hello from e2e');\nList<Account> accs = [SELECT Id FROM Account LIMIT 2];\n");
    cursorToEnd(apexEditor);
    await sleep(400);
    const r = await runAndWait(() => input([...typing('System.debug(LoggingLevel.WARN, accs.size());'), { key: 'ctrl+s' }]));
    check('Ctrl+S started exactly one run', r.started && r.runs === 1, { started: r.started, runs: r.runs });
    const text = r.text || '';
    check('header line', new RegExp(`^▶ Apex · ${ORG_RE} · \\d{2}:\\d{2}:\\d{2} · [\\d.]+ (s|ms)$`, 'm').test(text), text);
    check('success line', text.includes('✔ Compiled  ✔ Executed'), text);
    check('debug lines, the last typed one included', text.includes('  [line 1] DEBUG  hello from e2e') && text.includes('  [line 3] WARN   2'), text);
    check('limits', /Limits {2}SOQL queries 1\/100 · query rows 2\/50000/.test(text), text);
    check('file on disk keeps LF', !fs.readFileSync(apexFile, 'utf8').includes('\r'));
    const doc = outputDocument();
    if (doc) {
      check('output channel document uses language virga-output', doc.languageId === 'virga-output', doc.languageId);
      check('output channel shows the same text', doc.getText().includes('✔ Compiled  ✔ Executed') && doc.getText().includes('hello from e2e'), doc.getText());
    } else {
      note('output channel document not exposed to extensions; relying on the extension buffer', vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'output').map((d) => d.uri.toString()).join('\n') || '(none)');
    }
  });

  await step('a second run during a run is queued, never overlapping', async () => {
    apexEditor = await focus(apexFile);
    const before = api.stats();
    await setText(apexEditor, "System.debug('first');\n");
    await runCommand();
    await waitFor(() => api.stats().running, 8000, 25);
    const runningWhenAsked = api.stats().running;
    await setText(apexEditor, "System.debug('second');\n");
    await runCommand();
    await waitFor(() => api.stats().runs >= before.runs + 2 && !api.stats().running && api.stats().queueLength === 0, 60000, 100);
    await api.whenIdle();
    const after = api.stats();
    check('first run was still going at the second Ctrl+S', runningWhenAsked);
    check('two runs happened', after.runs - before.runs === 2, { before, after });
    check('the second one was queued', after.queued > before.queued, after);
    check('never two at once', after.maxActive === 1, after);
    check('output shows the latest run', api.outputText().includes('DEBUG  second') && !api.outputText().includes('DEBUG  first'), api.outputText());
  });

  await step('virga.scratch.run re-runs an unchanged scratch', async () => {
    apexEditor = await focus(apexFile);
    check('document is clean before', !apexEditor.document.isDirty);
    const r = await runAndWait(runCommand);
    check('ran without a change', r.started && r.runs === 1 && r.text.includes('DEBUG  second'), r.text);
  });

  await step('saves never run a scratch', async () => {
    apexEditor = await focus(apexFile);
    const runs = api.stats().runs;
    await setText(apexEditor, "System.debug('file save');\n");
    await vscode.commands.executeCommand('workbench.action.files.save'); // File > Save in the scratch
    await sleep(300);
    const notes = await dirtyNotes();
    await input([{ key: 'ctrl+s' }]); // default keymap: Ctrl+S in notes.txt saves notes.txt
    await sleep(1500);
    await api.whenIdle();
    check('File > Save in the scratch and Ctrl+S in another file ran nothing', api.stats().runs === runs && !notes.editor.document.isDirty, { runs: api.stats().runs - runs, notesDirty: notes.editor.document.isDirty });
    await closeAndRemove(notes.file);
    apexEditor = await focus(apexFile);
  });

  await step('(e) Save All from another dirty editor', () => saveAllElsewhereStep('(e) ', false));

  await step('compile error', async () => {
    apexEditor = await focus(apexFile);
    await setText(apexEditor, "Integer x = 1;\nStrin y = 'a';\n");
    const r = await runAndWait(runCommand);
    check('compile error with line, caret', r.text.includes('✖ Compile error line 2, column 1: Invalid type: Strin') && r.text.includes("  2 │ Strin y = 'a';\n    │ ^"), r.text);
  });

  await step('runtime exception', async () => {
    apexEditor = await focus(apexFile);
    await setText(apexEditor, "System.debug('before');\nInteger z = 0;\nInteger i = 1 / z;\n");
    const r = await runAndWait(runCommand);
    check('exception, stack, debug before it', r.text.includes('✔ Compiled  ✖ Exception: System.MathException: Divide by 0') && r.text.includes('  at AnonymousBlock: line 3, column 1') && r.text.includes('[line 1] DEBUG  before'), r.text);
  });

  let soqlFile;
  let soqlEditor;
  await step('new SOQL scratch and query', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newSoql');
    soqlFile = uri.fsPath;
    soqlEditor = vscode.window.activeTextEditor;
    check('file is scratch-1.soql', path.basename(soqlFile) === 'scratch-1.soql', soqlFile);
    check('language soql', soqlEditor.document.languageId === 'soql', soqlEditor.document.languageId);
    check('field list selected', soqlEditor.document.getText(soqlEditor.selection) === 'Id, Name', soqlEditor.document.getText(soqlEditor.selection));
    check('SOQL scratch auto-saves too', api.autoSaveDelay(soqlEditor.document) === 100);
    await setText(soqlEditor, 'SELECT Id, Name, Owner.Name, (SELECT Id FROM Contacts LIMIT 2)\nFROM Account\nORDER BY Name\nLIMIT 3\n');
    const r = await runAndWait(() => input([{ key: 'ctrl+s' }]));
    check('SOQL header and record count', r.runs === 1 && new RegExp(`^▶ SOQL · ${ORG_RE} · `, 'm').test(r.text) && r.text.includes('✔ 3 records'), r.text);
    check('table with dotted and subquery columns', /│ Id +│ Name +│ Owner\.Name +│ Contacts +│/.test(r.text) && /│ \[\d rows?\] +│/.test(r.text) && r.text.includes('┌') && r.text.includes('┘'), r.text);
    note('SOQL output', r.text);
  });

  await step('SOQL syntax error', async () => {
    soqlEditor = await focus(soqlFile);
    await setText(soqlEditor, 'SELECT Id FROM Account WHERE\n');
    const r = await runAndWait(runCommand);
    check('MALFORMED_QUERY with caret', /✖ MALFORMED_QUERY at row 1, column \d+: unexpected token/.test(r.text) && r.text.includes('  1 │ SELECT Id FROM Account WHERE'), r.text);
  });

  await step('split editor: closing one of two tabs keeps the file', async () => {
    await focus(soqlFile);
    await vscode.commands.executeCommand('workbench.action.splitEditor');
    await waitFor(() => tabsFor(soqlFile).length === 2, 5000);
    check('two tabs show the SOQL scratch', tabsFor(soqlFile).length === 2);
    await vscode.window.tabGroups.close(tabsFor(soqlFile)[1]);
    await sleep(1500);
    check('file still there with one tab open', exists(soqlFile) && tabsFor(soqlFile).length === 1);
    await vscode.window.tabGroups.close(tabsFor(soqlFile)[0]);
    check('closing the last tab deletes it', await waitFor(() => !exists(soqlFile), 5000, 100));
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
  });

  await step('closing the Apex tab deletes it', async () => {
    await vscode.window.tabGroups.close(tabsFor(apexFile));
    check('scratch-1.apex deleted', await waitFor(() => !exists(apexFile), 5000, 100));
  });

  await step('(b) type then Ctrl+F4 at once', () => typeThenCloseKeyStep('(b) ', 'ctrl+f4'));
  await step('(b) type then Ctrl+W at once', () => typeThenCloseKeyStep('(b) ', 'ctrl+w'));

  await step('(b) edit then tabGroups.close at once (the way an extension or the tab\'s close button closes it)', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const editor = vscode.window.activeTextEditor;
    await sleep(300);
    const d0 = dialogCount();
    await editor.edit((eb) => eb.insert(new vscode.Position(2, 0), "System.debug('closed at once');\n"));
    const dirtyAtClose = editor.document.isDirty;
    const closed = await withTimeout(vscode.window.tabGroups.close(tabsFor(uri.fsPath)), 8000);
    await sleep(1500);
    check('(b) close of a scratch with unsaved text returns at once (no modal)', closed.done && closed.value === true, { closed, dirtyAtClose });
    check('(b) no dialog', dialogCount() === d0, { dialogs: dialogCount() - d0 });
    check('(b) file deleted and stays deleted', await waitFor(() => !exists(uri.fsPath), 5000, 50) && (await sleep(800), !exists(uri.fsPath)));
  });

  await step('(b) Close All with two scratches holding unsaved text', async () => {
    const a = await vscode.commands.executeCommand('virga.scratch.newApex');
    const b = await vscode.commands.executeCommand('virga.scratch.newSoql');
    await sleep(300);
    const d0 = dialogCount();
    const we = new vscode.WorkspaceEdit(); // scratch-N.apex is in a background tab now: no TextEditor to edit
    we.insert(a, new vscode.Position(2, 0), 'x');
    we.insert(b, new vscode.Position(0, 0), ' ');
    await vscode.workspace.applyEdit(we);
    const closed = await withTimeout(Promise.resolve(vscode.commands.executeCommand('workbench.action.closeAllEditors')), 8000);
    await sleep(1500);
    check('(b) Close All finished without a dialog', closed.done && dialogCount() === d0 && allTabs().length === 0, { closed: closed.done, dialogs: dialogCount() - d0, tabs: allTabs().length });
    check('(b) both files deleted', await waitFor(() => !exists(a.fsPath) && !exists(b.fsPath), 5000, 50));
  });

  await step('revert and close deletes it too', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const editor = vscode.window.activeTextEditor;
    check('numbering continues in the session', /^scratch-\d+\.apex$/.test(path.basename(uri.fsPath)) && path.basename(uri.fsPath) !== 'scratch-1.apex', uri.fsPath);
    await editor.edit((eb) => eb.insert(new vscode.Position(2, 0), "System.debug('never run');\n"));
    const runs = api.stats().runs;
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    check('deleted after revert-and-close', await waitFor(() => !exists(uri.fsPath), 5000, 100));
    await sleep(500);
    check('and nothing ran', api.stats().runs === runs);
  });

  await step('closing a tab while its run is in progress', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const editor = vscode.window.activeTextEditor;
    await editor.edit((eb) => eb.insert(new vscode.Position(2, 0), "System.debug('closed mid-run');\n"));
    await runCommand();
    await waitFor(() => api.stats().running, 8000, 25);
    await vscode.window.tabGroups.close(tabsFor(uri.fsPath));
    const gone = await waitFor(() => (!exists(uri.fsPath) ? { running: api.stats().running } : null), 3000, 10);
    await api.whenIdle();
    check('(3) file deleted at once, while sf still runs (it reads its own copy)', gone && gone.running, gone);
    check('run completed normally', api.outputText().includes('DEBUG  closed mid-run'), api.outputText());
    runCopyChecks('', uri.fsPath);
    await sleep(800);
    check('and the file stays deleted', !exists(uri.fsPath));
  });

  await step('(1) a background save fails (file locked by another program), then close', lockedSaveStep);

  await step('File > Save immediately followed by close', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const editor = vscode.window.activeTextEditor;
    await editor.edit((eb) => eb.insert(new vscode.Position(2, 0), "System.debug('saved while closing');\n"));
    const runs = api.stats().runs;
    await vscode.commands.executeCommand('workbench.action.files.save');
    await vscode.window.tabGroups.close(tabsFor(uri.fsPath));
    check('file deleted', await waitFor(() => !exists(uri.fsPath), 5000, 100));
    await sleep(1000);
    check('nothing ran', api.stats().runs === runs && !api.stats().running, api.stats());
  });

  await step('moving a tab to another editor group keeps the file', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const mine = (t) => t.input && t.input.uri && t.input.uri.fsPath.toLowerCase() === uri.fsPath.toLowerCase();
    const events = [];
    const sub = vscode.window.tabGroups.onDidChangeTabs((e) => events.push({ opened: e.opened.filter(mine).length, closed: e.closed.filter(mine).length }));
    const original = vscode.window.tabGroups.activeTabGroup;
    await vscode.commands.executeCommand('workbench.action.newGroupRight');
    await vscode.window.showTextDocument(docOf(uri.fsPath), { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
    await sleep(1500);
    sub.dispose();
    const owner = vscode.window.tabGroups.all.find((g) => g.tabs.some(mine));
    check('tab moved to another group (VS Code reports it closed in the old one)', owner && owner !== original && events.some((e) => e.closed > 0), events);
    check('file survived the move', exists(uri.fsPath));
    await vscode.window.tabGroups.close(tabsFor(uri.fsPath));
    check('deleted after closing it there', await waitFor(() => !exists(uri.fsPath), 5000, 100));
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
  });

  await step('files outside the scratch folder are never touched', async () => {
    const foreign = path.join(ws, 'force-app', 'scratch-1.apex');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(foreign));
    await vscode.window.showTextDocument(doc, { preview: false });
    const runs = api.stats().runs;
    await runCommand(); // not a scratch: refuses
    await vscode.commands.executeCommand('workbench.action.files.save');
    await sleep(800);
    await vscode.window.tabGroups.close(tabsFor(foreign));
    await sleep(1200);
    check('force-app/scratch-1.apex still exists after open, run attempt, save, close', exists(foreign));
    check('and was not run', api.stats().runs === runs);
    const left = fs.readdirSync(dir).filter((n) => /^scratch-\d+\.(apex|soql)$/i.test(n));
    check('scratch folder holds no scratch files any more', left.length === 0, left.join(', '));
  });

  let running = {};
  await step('(3) closing a scratch during its run, right before the window closes', async () => { running = await closeWhileRunningStep(); });
  let graceFile = null;
  await step('(g) a scratch closed with the real grace period: its file stays until the grace period is over or the window closes', async () => { graceFile = await graceStep(); });
  await step('closing the window right after typing, with that run still going', () => windowCloseStep('', { ...running, graceFile }));
}

/**
 * The grace period as it is outside the tests (2 minutes): the closed
 * scratch's tab goes, its file stays (a tool that started on it still finds
 * it). The window closes next; run-e2e.mjs checks that the file went with it.
 */
async function graceStep() {
  api.setDiscardGraceMs(defaultGrace);
  check('(g) the grace period is 2 minutes', defaultGrace === 2 * 60 * 1000, String(defaultGrace));
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  await setText(vscode.window.activeTextEditor, "System.debug('closed just before the window');\n");
  await sleep(300);
  await withTimeout(vscode.window.tabGroups.close(tabsFor(uri.fsPath)), 8000);
  const discarded = await waitFor(() => api.stats().pendingDiscards >= 1, 3000, 20);
  await sleep(1000);
  check('(g) closed: no tab left, discarded, the file still there', discarded && tabsFor(uri.fsPath).length === 0 && exists(uri.fsPath), { discarded: !!discarded, tabs: tabsFor(uri.fsPath).length, exists: exists(uri.fsPath), stats: api.stats() });
  return uri.fsPath;
}

// ---------------------------------------------------------------------------
// IntelliJ IDEA keymap: Ctrl+S is Save All there
// ---------------------------------------------------------------------------

async function intellijSuite() {
  const prefix = '(f) ';
  await step('IntelliJ keymap is active', async () => {
    const one = await dirtyNotes('one.txt');
    const two = await dirtyNotes('two.txt');
    await input([{ key: 'ctrl+s' }]);
    await sleep(1000);
    check(`${prefix}Ctrl+S in a plain file saved every dirty file (Save All: the keymap is active)`, !one.editor.document.isDirty && !two.editor.document.isDirty, { one: one.editor.document.isDirty, two: two.editor.document.isDirty });
    await closeAndRemove(one.file);
    await closeAndRemove(two.file);
  });
  await step('(4) Ctrl+S, then typing goes on, with the IntelliJ keymap (the first run of the session)', () => keepTypingStep(prefix));
  await step('(d) Ctrl+S in the scratch with the IntelliJ keymap', async () => {
    const { uri } = await ctrlSRunsOnceStep(prefix);
    await withTimeout(vscode.window.tabGroups.close(tabsFor(uri.fsPath)), 8000);
    check(`${prefix}scratch deleted after closing`, await waitFor(() => !exists(uri.fsPath), 5000, 100));
  });
  await step('(e) Save All (Ctrl+S) in another dirty editor with the IntelliJ keymap', () => saveAllElsewhereStep(prefix, true));
  await step('(b) type then Ctrl+F4 with the IntelliJ keymap', () => typeThenCloseKeyStep(prefix, 'ctrl+f4'));
  await step('closing the window right after typing', () => windowCloseStep(prefix));
}

// ---------------------------------------------------------------------------
// a restart of VS Code with scratch tabs open (two runs on one profile)
// ---------------------------------------------------------------------------

const scratchFiles = () => (exists(dir) ? fs.readdirSync(dir).filter((n) => /^scratch-\d+\.(apex|soql)$/i.test(n)).sort() : []);
const inScratchFolder = (t) => t.input && t.input.uri && t.input.uri.scheme === 'file' && path.dirname(t.input.uri.fsPath).toLowerCase() === dir.toLowerCase();
const tabLayout = () => vscode.window.tabGroups.all.map((g) => g.tabs.map((t) => (t.input && t.input.uri ? `${path.basename(t.input.uri.fsPath)}${t.isPreview ? ' (preview)' : ''}${t.isActive ? ' (active)' : ''}` : t.label)));
// Notification toasts on screen: text, and whether it is an error.
const TOASTS = "[...document.querySelectorAll('.notifications-toasts .notification-list-item')].map((n) => ({ text: n.textContent, error: !!n.querySelector('.codicon-error') }))";

/**
 * Run A: three scratches with text, laid out the way tabs get restored in
 * every shape: scratch-1.apex in front in the first group (run-e2e.mjs deletes
 * its file before run B), scratch-2.apex behind it (never shown after the
 * restart, so VS Code has no document for it), scratch-1.soql as a preview tab
 * in a second group. Then VS Code quits (the driver), hot exit on.
 */
async function restoreSuiteA() {
  await step('(r) scratches open when VS Code quits', async () => {
    const texts = {};
    const make = async (command, text) => {
      const uri = await vscode.commands.executeCommand(command);
      await setText(vscode.window.activeTextEditor, text);
      texts[path.basename(uri.fsPath)] = text;
      return uri;
    };
    const front = await make('virga.scratch.newApex', "System.debug('in front when VS Code quit');\n");
    await make('virga.scratch.newApex', "System.debug('behind it');\n");
    const soql = await make('virga.scratch.newSoql', 'SELECT Id FROM Account LIMIT 1\n');
    await vscode.window.showTextDocument(docOf(soql.fsPath), { viewColumn: vscode.ViewColumn.Two, preview: true });
    const inFirst = vscode.window.tabGroups.all[0].tabs.filter((t) => t.input && t.input.uri && t.input.uri.fsPath.toLowerCase() === soql.fsPath.toLowerCase());
    await withTimeout(vscode.window.tabGroups.close(inFirst), 8000); // now only in the second group
    await vscode.window.showTextDocument(docOf(front.fsPath), { viewColumn: vscode.ViewColumn.One, preview: false });
    const written = await waitFor(() => Object.entries(texts).every(([n, t]) => {
      const d = docOf(path.join(dir, n));
      return d && !d.isDirty && fs.readFileSync(path.join(dir, n), 'utf8') === t;
    }), 5000, 50);
    const layout = tabLayout();
    check('(r) three scratches written, the SOQL one alone in a second group, scratch-1.apex in front', written && vscode.window.tabGroups.all.length === 2 && scratchFiles().length === 3 && layout[0][0].startsWith('scratch-1.apex') && layout[1].length === 1 && layout[1][0].startsWith('scratch-1.soql'), { layout, files: scratchFiles() });
    check('(r) nothing closed or kept as restored in a fresh profile', api.stats().tabsClosedMissing.length + api.stats().tabsClosedRestored.length + api.stats().tabsKeptRestored.length === 0, api.stats());
    note('(r) tabs when VS Code quits', layout);
    fs.writeFileSync(path.join(IPC, 'restore-a.json'), JSON.stringify({ files: texts, front: path.basename(front.fsPath) }));
  });
}

/**
 * Run B: what VS Code restored, what the extension did with it, a scratch an
 * analyze-on-open extension (e2e/fake-analyzer, Salesforce Code Analyzer's
 * code path) is still reading when its tab closes, a new scratch, and the
 * grace period ending. The grace period stays at its real length (2 minutes)
 * until the last step.
 */
async function restoreSuiteB() {
  const expect = JSON.parse(fs.readFileSync(path.join(IPC, 'restore-b.json'), 'utf8'));
  await step('(r) VS Code started again with the scratch tabs of the last session', async () => {
    const want = expect.missing.length + expect.restored.length;
    await waitFor(() => api.stats().tabsClosedMissing.length + api.stats().tabsClosedRestored.length >= want, 15000, 50);
    const st = api.stats();
    const sorted = (a) => [...a].sort();
    check('(r) the restored tab whose file was gone was closed', !expect.runAFailed && JSON.stringify(sorted(st.tabsClosedMissing)) === JSON.stringify(sorted(expect.missing)), { expect, st });
    check('(r) the restored tabs of the scratches the closed VS Code had left were closed (scratches end with their window)', !expect.runAFailed && JSON.stringify(sorted(st.tabsClosedRestored)) === JSON.stringify(sorted(expect.restored)), { expect, st });
    check('(r) none was kept', st.tabsKeptRestored.length === 0, st);
    const left = allTabs().filter(inScratchFolder).map((t) => ({ name: path.basename(t.input.uri.fsPath), exists: exists(t.input.uri.fsPath) }));
    check('(r) no tab points into .sfdx/virga-scratch', left.length === 0, { left, layout: tabLayout() });
    check('(r) in particular no tab of a scratch file that does not exist', left.every((t) => t.exists), left);
    const discarded = await waitFor(() => api.stats().pendingDiscards >= expect.restored.length, 8000, 50);
    check('(r) the closed scratches are discarded: their files wait out the grace period (an extension that got to them first still finds them)', discarded && JSON.stringify(scratchFiles()) === JSON.stringify(sorted(expect.restored)), { files: scratchFiles(), stats: api.stats() });
    check('(r) the one whose file was gone is not brought back', expect.missing.every((n) => !exists(path.join(dir, n))), scratchFiles());
    check('(r) nothing written to the Virga output', api.outputText() === '', api.outputText());
    const toasts = (await input([{ evaluate: TOASTS }])).values[0];
    check('(r) no notification from Virga or about a scratch file', !toasts.some((t) => /scratch/i.test(t.text)), toasts);
    check('(r) no error notification at all', !toasts.some((t) => t.error), toasts);
    note('(r) tabs after the restart', tabLayout());
    if (toasts.length) note('(r) notifications on screen', toasts);
    probeNotes();
  });

  await step('(c) a scratch closed while an analyze-on-open extension still reads it', async () => {
    const r = await analyzedThenClosed();
    check('(c) the analyzer started on the scratch when it became the active editor', !!r.start, r);
    check('(c) and still found the file when it read it, after the tab was closed', r.done && r.done.found === true, r);
    check('(c) no "Analysis failed ... does not exist" notification', !r.toasts.some((t) => /does not exist/i.test(t.text)), r.toasts);
    check('(c) the scratch is discarded all the same: no tab, no claim, its file only waits out the grace period', tabsFor(r.file).length === 0 && api.stats().pendingDiscards >= 1, api.stats());
  });

  await step('(r) a new scratch after the restart', async () => {
    const { uri } = await ctrlSRunsOnceStep('(r) ');
    note('(r) the new scratch', path.basename(uri.fsPath));
    const before = api.stats().pendingDiscards;
    await withTimeout(vscode.window.tabGroups.close(tabsFor(uri.fsPath)), 8000);
    check('(r) closing it discards it', await waitFor(() => api.stats().pendingDiscards === before + 1, 5000, 50) && tabsFor(uri.fsPath).length === 0, api.stats());
  });

  await step('(c) control: without the grace period the same analyzer reports the missing file (so the check above can fail)', async () => {
    api.setDiscardGraceMs(0);
    const r = await analyzedThenClosed();
    check('(c) control: the file was gone when the analyzer read it, and it said so', r.done && r.done.found === false && r.toasts.some((t) => t.error && /does not exist/i.test(t.text)), r);
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  await step('(r) the grace period over: nothing left', async () => {
    api.setDiscardGraceMs(0); // ends the grace period of every scratch still waiting
    check('(r) no scratch file left while VS Code still runs', await waitFor(() => scratchFiles().length === 0 && api.stats().pendingDiscards === 0, 5000, 50), { files: scratchFiles(), stats: api.stats() });
    check('(r) and the scratch folder is gone', await waitFor(() => !exists(dir), 3000, 50), exists(dir) ? fs.readdirSync(dir) : null);
  });
}

/**
 * New scratch (the active editor, so the analyzer starts on it), some text,
 * closed 1.5 s later; then waits until the analyzer has read the file.
 */
async function analyzedThenClosed() {
  const log = process.env.VIRGA_E2E_ANALYZER;
  const events = () => {
    try {
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (err) {
      return [];
    }
  };
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const file = uri.fsPath;
  const mine = (e) => e.file && e.file.toLowerCase() === file.toLowerCase();
  const start = await waitFor(() => events().find((e) => e.event === 'start' && mine(e)), 5000, 20);
  await setText(vscode.window.activeTextEditor, "System.debug('closed while being analyzed');\n");
  await sleep(1500);
  await withTimeout(vscode.window.tabGroups.close(tabsFor(file)), 8000);
  const scanMs = Number(process.env.VIRGA_E2E_ANALYZER_MS) || 8000;
  const done = await waitFor(() => events().find((e) => e.event === 'done' && mine(e)), scanMs + 10000, 50);
  await sleep(500);
  const toasts = (await input([{ evaluate: TOASTS }])).values[0];
  return { file, start: start || null, done: done || null, toasts };
}

/** What e2e/probe (an extension started with VS Code) saw of scratch tabs: notes, not checks (activation order is VS Code's). */
function probeNotes() {
  let events = [];
  try {
    events = fs.readFileSync(process.env.VIRGA_E2E_PROBE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    note('(r) probe extension: no log', String(err));
    return;
  }
  const start = events.find((e) => e.event === 'activate');
  const dangling = events.filter((e) => e.tabs && e.tabs.some((t) => !t.exists));
  const lastDangling = dangling.length ? dangling[dangling.length - 1].t : null;
  const firstEmpty = events.find((e) => e.tabs && e.tabs.length === 0 && e.t >= (lastDangling || 0));
  note('(r) probe extension (activates with VS Code): scratch tabs at its start; ms until no tab without a file, until no scratch tab', {
    atStart: start && start.tabs,
    activeEditorAtStart: start && start.activeEditor,
    documentsAtStart: start && start.documents,
    noDanglingTabAfterMs: lastDangling === null ? 0 : (events.find((e) => e.tabs && e.t > lastDangling) || {}).t,
    noScratchTabAfterMs: firstEmpty ? firstEmpty.t : null,
    editorsOrDocumentsOfMissingFiles: events.filter((e) => (e.event === 'activeEditor' || e.event === 'openDocument') && !e.exists),
  });
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// two windows on one project: the folder (window 1) and proj.code-workspace
// (window 2), opened from window 1. Two VS Code runs on one profile.
//
// multi-a, the bug of 2026-10-14 22:xx (a reload while another window touches
// a scratch): window 1 makes scratch-1, window 2 scratch-2 and scratch-3;
// window 1 reloads, and window 2 closes scratch-2 the moment window 1's old
// extension host is gone, so it reads window 1's owner file in the gap.
// Window 1's next host must keep scratch-1 with its text. Then window 2 also
// opens scratch-1 and closes its window (VS Code keeps its tabs for its
// workspace); window 1 quits. run-e2e.mjs makes the files an hour old.
//
// multi-b: VS Code starts again with the folder. It closes its restored
// scratch-1 tab, but the files stay: window 2's workspace kept them, and the
// leftover sweep does not touch them, old as they are. Then window 2's
// workspace opens again: its restored tabs find their files (closed as
// restored, never as missing, so no "file not found" editor), and the last
// of the two windows deletes them.
// ---------------------------------------------------------------------------

const WS_FILE_NAME = 'proj.code-workspace';
const isWindow2 = () => !!vscode.workspace.workspaceFile;
const marker = (name) => path.join(IPC, `${MODE}-${name}.json`);
const writeMarker = (name, value = {}) => {
  fs.writeFileSync(`${marker(name)}.tmp`, JSON.stringify(value));
  fs.renameSync(`${marker(name)}.tmp`, marker(name));
};
const readMarker = (name) => {
  try {
    return JSON.parse(fs.readFileSync(marker(name), 'utf8'));
  } catch (err) {
    return null;
  }
};
const waitMarker = (name, timeout = 60000) => waitFor(() => readMarker(name), timeout, 10);
const processGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code !== 'EPERM';
  }
};
/** The owner files in the scratch folder: [{ name, pid, files }]. */
const ownerFiles = () => (exists(dir) ? fs.readdirSync(dir).filter((n) => /^\.owner-.*\.json$/.test(n)).map((n) => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    return { name: n, pid: j.pid, files: j.files };
  } catch (err) {
    return { name: n, unreadable: true };
  }
}) : []);
const prefixed = (p) => results.map((r) => ({ ...r, name: `${p}${r.name}` }));

async function openWindow2() {
  const file = path.join(ws, WS_FILE_NAME);
  if (!exists(file)) fs.writeFileSync(file, JSON.stringify({ folders: [{ path: '.' }], settings: {} }, null, 2));
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(file), { forceNewWindow: true });
}

async function openScratchHere(file) {
  return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false });
}

async function multiSuite() {
  if (MODE === 'multi-a') {
    if (isWindow2()) return multiA2();
    const reload = readMarker('reload');
    if (reload && reload.pid !== process.pid) return multiA1AfterReload(reload);
    return multiA1();
  }
  return isWindow2() ? multiB2() : multiB1();
}

/** Window 1, first host: scratch-1, window 2, then Reload Window. */
async function multiA1() {
  await step('(m) window 1 makes scratch-1 and opens window 2', async () => {
    const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
    const text = "System.debug('typed before the reload');\n";
    await setText(vscode.window.activeTextEditor, text);
    const written = await waitFor(() => !docOf(uri.fsPath).isDirty && fs.readFileSync(uri.fsPath, 'utf8') === text, 5000, 20);
    check('(m) scratch-1.apex written in window 1', written && path.basename(uri.fsPath) === 'scratch-1.apex', uri.fsPath);
    await openWindow2();
    const ready = await waitMarker('w2-ready', 60000);
    check('(m) window 2 (proj.code-workspace) started with its two scratches', ready && JSON.stringify(ready.files) === JSON.stringify(['scratch-2.apex', 'scratch-3.apex']), ready);
    writeMarker('w1-before', { results, text, file: uri.fsPath });
  });
  writeMarker('reload', { pid: process.pid, at: Date.now() });
  vscode.commands.executeCommand('workbench.action.reloadWindow'); // this extension host ends here
  return { closedWindow: true }; // the driver must not quit: the window comes back
}

/** Window 2: two scratches; closes one of them in window 1's reload gap. */
async function multiA2() {
  let s2;
  let s3;
  await step('(m) window 2 makes scratch-2 and scratch-3', async () => {
    s2 = await vscode.commands.executeCommand('virga.scratch.newApex');
    s3 = await vscode.commands.executeCommand('virga.scratch.newApex');
    await setText(vscode.window.activeTextEditor, "System.debug('window 2');\n");
  });
  writeMarker('w2-ready', { files: [s2, s3].map((u) => u && path.basename(u.fsPath)) });
  await step('(m) window 2 closes scratch-2 while window 1 reloads', async () => {
    const reload = await waitMarker('reload', 60000);
    const gone = reload && await waitFor(() => processGone(reload.pid), 15000, 2);
    const msAfterReload = Date.now() - (reload ? reload.at : Date.now());
    await withTimeout(vscode.window.tabGroups.close(tabsFor(s2.fsPath)), 8000);
    const deleted = await waitFor(() => !exists(s2.fsPath), 3000, 5);
    api.cleanupLeftovers(0); // one more reader of window 1's owner file in the gap
    const after = readMarker('w1-after');
    note('(m) window 1\'s old extension host gone, then scratch-2 closed and deleted, ms after the reload request', { gone: !!gone, closedAtMs: msAfterReload, deletedAtMs: Date.now() - (reload ? reload.at : 0), window1BackYet: !!after });
    check('(m) window 2\'s closed scratch-2 is deleted', deleted);
    const claim = ownerFiles().find((o) => o.pid !== process.pid && (o.files || []).includes('scratch-1.apex'));
    check('(m) window 1\'s claim on scratch-1 is still there after window 2 read it (its old host\'s owner file, or its new host\'s)', !!claim, ownerFiles());
    note('(m) the owner file of window 1 that window 2 saw in the gap belongs to', claim ? (claim.pid === (reload && reload.pid) ? 'its old host (gone)' : 'its new host') : 'nobody');
    check('(m) window 1\'s scratch-1 is still there', exists(path.join(dir, 'scratch-1.apex')));
  });
  await step('(m) window 2 also shows scratch-1, then closes its window', async () => {
    const after = await waitMarker('w1-after', 90000);
    check('(m) window 1 came back from the reload', !!after);
    await openScratchHere(path.join(dir, 'scratch-1.apex'));
    await sleep(500);
    const mine = ownerFiles().find((o) => o.pid === process.pid);
    check('(m) window 2 claims scratch-1 and scratch-3', mine && JSON.stringify([...mine.files].sort()) === JSON.stringify(['scratch-1.apex', 'scratch-3.apex']), ownerFiles());
  });
  writeMarker('w2-done', { results, pid: process.pid });
  vscode.commands.executeCommand('workbench.action.closeWindow'); // its tabs stay with proj.code-workspace
  return { closedWindow: true };
}

/** Window 1, the host after the reload: scratch-1 must still be there and run. */
async function multiA1AfterReload(reload) {
  const before = readMarker('w1-before') || { results: [], text: null };
  await step('(m) window 1 after Reload Window', async () => {
    note('(m) window 1\'s new extension host started, ms after the reload request', String(Date.now() - reload.at));
    await sleep(500);
    const st = api.stats();
    const file = path.join(dir, 'scratch-1.apex');
    check('(m) its scratch-1 tab is kept, nothing closed', st.tabsKeptRestored.includes('scratch-1.apex') && st.tabsClosedRestored.length === 0 && st.tabsClosedMissing.length === 0, st);
    check('(m) the tab is open and the file has the text typed before the reload', tabsFor(file).length === 1 && exists(file) && fs.readFileSync(file, 'utf8') === before.text, { tabs: tabsFor(file).length, exists: exists(file), layout: tabLayout() });
    const mine = ownerFiles().find((o) => o.pid === process.pid);
    check('(m) window 1\'s owner file belongs to its new host and lists scratch-1 (the old one\'s, written over)', mine && JSON.stringify(mine.files) === JSON.stringify(['scratch-1.apex']) && !ownerFiles().some((o) => o.pid === reload.pid), ownerFiles());
    await waitFor(() => !api.stats().startup, 10000, 50);
    check('(m) still there after the startup sweep', tabsFor(file).length === 1 && exists(file), { tabs: tabsFor(file).length, exists: exists(file) });
    await focus(file);
    const r = await runAndWait(runCommand);
    check('(m) and it runs', r.started && r.runs === 1 && r.text.includes('DEBUG  typed before the reload'), r.text);
  });
  writeMarker('w1-after', {});
  let window2 = [];
  await step('(m) window 2 done', async () => {
    const done = await waitMarker('w2-done', 90000);
    check('(m) window 2 finished', !!done);
    if (done) {
      window2 = done.results;
      check('(m) window 2\'s window closed', await waitFor(() => processGone(done.pid), 20000, 50));
    }
  });
  const all = [
    ...before.results.map((x) => ({ ...x, name: `[window 1, before the reload] ${x.name}` })),
    ...window2.map((x) => ({ ...x, name: `[window 2] ${x.name}` })),
    ...prefixed('[window 1] '),
  ];
  results.length = 0;
  results.push(...all);
  return undefined; // run() writes the results; the driver quits
}

/** Window 1 after the restart: its restored scratch-1 tab closes, the files wait for window 2's workspace. */
async function multiB1() {
  await step('(m) the folder window after the restart', async () => {
    await waitFor(() => api.stats().tabsClosedRestored.length + api.stats().tabsClosedMissing.length >= 1, 15000, 50);
    const st = api.stats();
    check('(m) its restored scratch-1 tab was closed (found its file: not as missing)', JSON.stringify(st.tabsClosedRestored) === JSON.stringify(['scratch-1.apex']) && st.tabsClosedMissing.length === 0 && st.tabsKeptRestored.length === 0, st);
    check('(m) no tab points into .sfdx/virga-scratch', allTabs().filter(inScratchFolder).length === 0, tabLayout());
    await waitFor(() => !api.stats().startup, 10000, 50);
    await sleep(500);
    check('(m) after the startup sweep both files are still there, an hour old: window 2\'s workspace kept them', JSON.stringify(scratchFiles()) === JSON.stringify(['scratch-1.apex', 'scratch-3.apex']), { files: scratchFiles(), owners: ownerFiles() });
    check('(m) of the owner files only window 2\'s is left (window 1 took its own old one over)', ownerFiles().length === 1 && JSON.stringify([...(ownerFiles()[0].files || [])].sort()) === JSON.stringify(['scratch-1.apex', 'scratch-3.apex']), ownerFiles());
  });
  await openWindow2();
  let window2 = [];
  await step('(m) window 2\'s workspace opened again', async () => {
    const done = await waitMarker('w2-done', 90000);
    check('(m) window 2 finished', !!done);
    if (done) {
      window2 = done.results;
      check('(m) window 2\'s window closed', await waitFor(() => processGone(done.pid), 20000, 50));
    }
    check('(m) nothing left in the scratch folder: the last window deleted the scratches', await waitFor(() => !exists(dir), 5000, 50), exists(dir) ? fs.readdirSync(dir) : null);
  });
  const all = [...window2.map((x) => ({ ...x, name: `[window 2] ${x.name}` })), ...prefixed('[window 1] ')];
  results.length = 0;
  results.push(...all);
  return undefined; // run() writes the results; the driver quits
}

/** Window 2 after the restart: its restored tabs find their files, close, and the files go. */
async function multiB2() {
  await step('(m) window 2 opened again with its restored tabs', async () => {
    await waitFor(() => api.stats().tabsClosedRestored.length + api.stats().tabsClosedMissing.length >= 2, 15000, 50);
    const st = api.stats();
    check('(m) both restored tabs found their files and were closed as restored, none as missing (no "file not found" editor)', JSON.stringify([...st.tabsClosedRestored].sort()) === JSON.stringify(['scratch-1.apex', 'scratch-3.apex']) && st.tabsClosedMissing.length === 0 && st.tabsKeptRestored.length === 0, st);
    check('(m) no tab points into .sfdx/virga-scratch', allTabs().filter(inScratchFolder).length === 0, tabLayout());
    await waitFor(() => !api.stats().startup, 10000, 50);
    check('(m) the scratch files are deleted', await waitFor(() => scratchFiles().length === 0, 5000, 50), { files: scratchFiles(), owners: ownerFiles(), stats: api.stats() });
    note('(m) window 2 tabs', tabLayout());
  });
  writeMarker('w2-done', { results, pid: process.pid });
  vscode.commands.executeCommand('workbench.action.closeWindow');
  return { closedWindow: true };
}

async function run() {
  await sleep(1000);
  const ext = vscode.extensions.getExtension('WiktorMayska.virga');
  check('extension found', !!ext);
  api = await ext.activate();
  ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  dir = path.join(ws, '.sfdx', 'virga-scratch');
  defaultGrace = api.discardGraceMs();
  // The checks below expect a closed scratch's file to go at once; the restart passes and
  // graceStep look at the grace period itself.
  if (MODE !== 'restore-b') api.setDiscardGraceMs(0);
  if (MODE === 'multi-a' || MODE === 'multi-b') {
    const res = await multiSuite();
    if (res && res.closedWindow) return res; // window 2, or window 1 before its reload: window 1's last host writes the results
    fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    // workbench.action.quit does nothing once this session has had a second window (VS Code 1.141,
    // extension development host); closing the last window quits.
    vscode.commands.executeCommand('workbench.action.closeWindow');
    return { closedWindow: true };
  } else if (MODE === 'intellij') await intellijSuite();
  else if (MODE === 'restore-a') await restoreSuiteA();
  else if (MODE === 'restore-b') await restoreSuiteB();
  else await mainSuite();

  const closing = fs.existsSync(path.join(IPC, 'window-close.json'));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  if (closing) {
    // Not awaited: the extension host goes down with the window. files.hotExit is off in this profile,
    // so VS Code asks about every dirty file it cannot auto save; dialog-watch.ps1 would log it.
    vscode.commands.executeCommand('workbench.action.closeWindow');
    return { closedWindow: true };
  }
  return { closedWindow: false };
}

module.exports = {
  run: () => run().catch((err) => {
    try {
      results.push({ name: 'suite crashed', ok: false, detail: String((err && err.stack) || err) });
      fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    } catch (e) {
      // nothing
    }
    throw err;
  }),
};
