'use strict';

// Dev-only stand-in for the `vscode` module: just enough of the API for
// src/scratch/extension.js to activate in plain Node, so test/scratch.test.js can drive its event
// handlers (typing, saves, tab changes, shutdown) without a VS Code window.
// The real extension host is covered by e2e/. Not shipped.
//
// It copies the parts of VS Code's behaviour the extension relies on:
// - files.autoSave "afterDelay" is a debounce: every change restarts the timer,
//   then the document is saved with reason AUTO;
// - a dirty document whose auto save delay is <= 1000 ms counts as "being
//   saved": closing its tab asks nothing (editorGroupView.shouldConfirmClose);
//   any other dirty document closing in its last tab gets the "save changes?"
//   prompt (recorded in __prompts, answered "Don't Save", which reverts);
// - a save that fails (the file cannot be written) leaves the document dirty
//   in an error state: it no longer counts as "being saved" (FileEditorInput.
//   isSaving() is false with an error), so closing it asks, and auto save does
//   not try again until the next edit;
// - a closed document stays open (and dirty) until it is written, then closes;
// - tabs VS Code restored from the last session exist before the extension
//   activates, and one that was never shown has no document (__restoreTab);
// - tabGroups.close(tabs) closes them a moment later, like a round trip to the
//   workbench, and fails as a whole when one of them is stale (a tab object
//   from before the tab model was replaced, __replaceTabModel).
// Every loadExtension is one window with its own tabs and documents; several
// can run side by side on one project (their hosts share this process's id, so
// a test that needs a host that ended rewrites its owner file).

const Module = require('module');
const fs = require('fs');
const path = require('path');

const SHORT_AUTO_SAVE_MAX_MS = 1000;

function createFakeVscode(root) {
  const listeners = { willSave: [], didSave: [], tabs: [], close: [], change: [], groups: [], windowState: [] };
  const output = { text: '', shows: 0 };
  const statusMessages = [];
  const errorMessages = [];
  const infoMessages = [];
  const groups = [{ tabs: [] }];
  const docs = [];
  const config = {}; // virga.scratch.*
  // files.* as VS Code resolves it for the scratch languages: package.json's configurationDefaults.
  const filesConfig = { autoSave: 'afterDelay', autoSaveDelay: 100 };
  const configReads = [];
  // Every save that reached a document: { file, via: 'auto' | 'explicit' | 'workbench', start, end }
  const saves = [];
  const prompts = []; // files VS Code would have asked about ("Do you want to save the changes?")
  const closeCalls = []; // tabGroups.close requests: { files, preserveFocus, duringActivation }
  let tabSeq = 0;
  const newTabId = () => `tab-${(tabSeq += 1)}`;
  const inFlight = new Map(); // file -> saves of it running right now
  let maxInFlight = 0;

  class Uri {
    constructor(fsPath) {
      this.scheme = 'file';
      this.fsPath = path.resolve(fsPath);
    }
    static file(p) {
      return new Uri(p);
    }
    toString() {
      return `file:///${this.fsPath.replace(/\\/g, '/')}`;
    }
  }
  const sub = (list) => (fn) => {
    list.push(fn);
    return { dispose() {} };
  };
  const item = () => ({ text: '', tooltip: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} });
  const sameFile = (a, b) => a.toLowerCase() === b.toLowerCase();

  function makeDoc(file) {
    const uri = Uri.file(file);
    const existing = docs.find((d) => sameFile(d.uri.fsPath, uri.fsPath));
    if (existing) return existing;
    let text = '';
    try {
      text = fs.readFileSync(uri.fsPath, 'utf8');
    } catch (err) {
      // new file
    }
    const doc = {
      uri,
      isDirty: false,
      isClosed: false,
      version: 1,
      languageId: 'plaintext',
      text,
      autoSaveTimer: null,
      saveError: false,
      getText: () => doc.text,
      save: () => vscode.__saveNow(doc, 'explicit'),
    };
    docs.push(doc);
    return doc;
  }

  function tabsOf(doc) {
    return tabsFor(doc.uri.fsPath);
  }

  function tabsFor(file) {
    return groups.flatMap((g) => g.tabs).filter((t) => sameFile(t.input.uri.fsPath, path.resolve(file)));
  }

  /** The document VS Code holds for `file`, without creating one (a tab that was never shown has none). */
  function docFor(file) {
    return docs.find((d) => sameFile(d.uri.fsPath, path.resolve(file))) || null;
  }

  function shortAutoSave() {
    return filesConfig.autoSave === 'afterDelay' && Number(filesConfig.autoSaveDelay) <= SHORT_AUTO_SAVE_MAX_MS;
  }

  function scheduleAutoSave(doc) {
    if (doc.autoSaveTimer) clearTimeout(doc.autoSaveTimer);
    doc.autoSaveTimer = null;
    if (filesConfig.autoSave !== 'afterDelay') return;
    doc.autoSaveTimer = setTimeout(() => {
      doc.autoSaveTimer = null;
      if (doc.isDirty && !doc.isClosed) vscode.__saveNow(doc, 'auto');
    }, Number(filesConfig.autoSaveDelay));
  }

  /** The document lost its last tab: VS Code disposes it once it is not dirty any more. */
  function releaseIfUnused(doc) {
    if (doc.isClosed || doc.isDirty || tabsOf(doc).length) return;
    setTimeout(() => {
      if (doc.isClosed || doc.isDirty || tabsOf(doc).length) return;
      doc.isClosed = true;
      docs.splice(docs.indexOf(doc), 1);
      listeners.close.forEach((f) => f(doc));
    }, 0);
  }

  const vscode = {
    Uri,
    StatusBarAlignment: { Left: 1, Right: 2 },
    TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
    Selection: class {
      constructor(a, b, c, d) {
        Object.assign(this, { a, b, c, d });
      }
    },
    window: {
      activeTextEditor: null,
      createOutputChannel: () => ({
        replace(t) { output.text = t; },
        show() { output.shows += 1; },
        append(t) { output.text += t; },
        clear() { output.text = ''; },
        dispose() {},
      }),
      createStatusBarItem: item,
      setStatusBarMessage: (m) => {
        statusMessages.push(m);
        return { dispose() {} };
      },
      showInformationMessage: (m) => {
        infoMessages.push(m);
        return undefined;
      },
      showWarningMessage: () => undefined,
      showErrorMessage: (m) => {
        errorMessages.push(m);
        return undefined;
      },
      onDidChangeWindowState: sub(listeners.windowState),
      showTextDocument: async (doc) => {
        if (tabsOf(doc).length) vscode.__focus(doc.uri.fsPath);
        else vscode.__openTab(doc.uri.fsPath);
        return vscode.window.activeTextEditor;
      },
      tabGroups: {
        get all() { return groups; },
        get activeTabGroup() {
          const ed = vscode.window.activeTextEditor;
          return { activeTab: ed ? tabsOf(ed.document)[0] : undefined };
        },
        onDidChangeTabs: sub(listeners.tabs),
        onDidChangeTabGroups: sub(listeners.groups),
        /** ExtHostEditorTabs.close: every tab must be in the current model, else nothing is closed. */
        async close(tabOrTabs, preserveFocus) {
          const list = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs];
          closeCalls.push({ files: list.map((t) => t.input.uri.fsPath), preserveFocus: !!preserveFocus, duringActivation: vscode.__activating });
          for (const t of list) {
            if (!groups.some((g) => g.tabs.includes(t))) throw new Error('Tab close: Invalid tab not found!');
          }
          const ids = new Set(list.map((t) => t.id)); // the workbench closes them by id ($closeTab)
          await new Promise((r) => setTimeout(r, 0));
          for (const t of groups.flatMap((g) => g.tabs).filter((x) => ids.has(x.id))) vscode.__closeTab(t);
          return true;
        },
      },
    },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(root), name: path.basename(root), index: 0 }],
      workspaceFile: undefined, // a .code-workspace window: set it in loadExtension's before()
      get textDocuments() { return docs; },
      getConfiguration: (section, scope) => {
        const resource = scope && (scope.fsPath ? scope : scope.uri);
        configReads.push({ section, resource: resource ? resource.fsPath : undefined, languageId: scope && scope.languageId });
        const values = section === 'files' ? filesConfig : config;
        return { get: (k, d) => (k in values ? values[k] : d) };
      },
      openTextDocument: async (uri) => makeDoc(uri.fsPath),
      onWillSaveTextDocument: sub(listeners.willSave),
      onDidSaveTextDocument: sub(listeners.didSave),
      onDidCloseTextDocument: sub(listeners.close),
      onDidChangeTextDocument: sub(listeners.change),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      getWorkspaceFolder: () => vscode.workspace.workspaceFolders[0],
    },
    commands: {
      registered: new Map(),
      executed: [],
      registerCommand(id, fn) {
        this.registered.set(id, fn);
        return { dispose() {} };
      },
      async executeCommand(id, ...args) {
        this.executed.push(id);
        if (this.registered.has(id)) return this.registered.get(id)(...args);
        throw new Error(`fake vscode: unknown command ${id}`);
      },
    },
    extensions: {
      // The Salesforce extensions that bring the scratch languages; a test clears it for a machine without them.
      installed: new Set(['salesforce.salesforcedx-vscode-apex', 'salesforce.salesforcedx-vscode-soql']),
      getExtension(id) {
        return this.installed.has(id) ? { id, isActive: true } : undefined;
      },
    },
    languages: {
      getLanguages: async () => ['apex-anon', 'soql'],
      setTextDocumentLanguage: async (doc, id) => {
        doc.languageId = id;
        return doc;
      },
    },

    // --- test controls ---
    __output: output,
    __statusMessages: statusMessages,
    __errorMessages: errorMessages,
    __infoMessages: infoMessages,
    __config: config,
    __filesConfig: filesConfig,
    __configReads: configReads,
    __saves: saves,
    __prompts: prompts,
    __closeCalls: closeCalls,
    __activating: false, // true while loadExtension runs activate()
    get __maxInFlight() { return maxInFlight; },
    /** How long writing a file takes (ms); 0 resolves on the next turn of the event loop. */
    __saveDelayMs: 0,
    /** Opens a tab for `file` in group `g` and focuses it. */
    __openTab(file, g = 0) {
      const doc = makeDoc(file);
      while (groups.length <= g) groups.push({ tabs: [] });
      const tab = { id: newTabId(), input: { uri: doc.uri }, isPreview: false };
      groups[g].tabs.push(tab);
      vscode.window.activeTextEditor = { document: doc, selection: null, revealRange() {} };
      listeners.tabs.forEach((f) => f({ opened: [tab], closed: [], changed: [] }));
      return tab;
    },
    /**
     * Closes a tab the way an editor group does: the last tab of a dirty
     * document asks to save unless the document counts as being saved (short
     * auto save); the prompt is answered "Don't Save", which reverts it.
     */
    __closeTab(tab) {
      const doc = docFor(tab.input.uri.fsPath); // a restored tab that was never shown has none
      const last = tabsFor(tab.input.uri.fsPath).length === 1;
      if (doc && last && doc.isDirty && (!shortAutoSave() || doc.saveError)) {
        prompts.push(doc.uri.fsPath);
        if (doc.autoSaveTimer) clearTimeout(doc.autoSaveTimer);
        doc.text = fs.existsSync(doc.uri.fsPath) ? fs.readFileSync(doc.uri.fsPath, 'utf8') : '';
        doc.version += 1;
        doc.isDirty = false;
      }
      for (const g of groups) {
        const i = g.tabs.indexOf(tab);
        if (i >= 0) g.tabs.splice(i, 1);
      }
      listeners.tabs.forEach((f) => f({ opened: [], closed: [tab], changed: [] }));
      if (doc) releaseIfUnused(doc);
    },
    __tabOf: (file) => tabsOf(makeDoc(file))[0],
    __tabsFor: tabsFor,
    __docFor: docFor,
    /**
     * A tab VS Code restored from the last session, there before the extension
     * activates (no event). `shown`: its editor was opened (a document exists,
     * read from disk; never for a file that is gone, VS Code shows an error then).
     * `dirty`: unsaved text from a hot exit backup.
     */
    __restoreTab(file, { group = 0, preview = false, shown = false, dirty = null } = {}) {
      while (groups.length <= group) groups.push({ tabs: [] });
      const tab = { id: newTabId(), input: { uri: Uri.file(file) }, isPreview: preview };
      groups[group].tabs.push(tab);
      if (shown && fs.existsSync(file)) {
        const doc = makeDoc(file);
        if (dirty !== null) {
          doc.text = dirty;
          doc.isDirty = true;
          scheduleAutoSave(doc);
        }
        if (!vscode.window.activeTextEditor) vscode.window.activeTextEditor = { document: doc, selection: null, revealRange() {} };
      }
      return tab;
    },
    /** The workbench sends the whole tab model again (startup, a group added): new tab objects, onDidChangeTabGroups. */
    __replaceTabModel(extraTabs = []) {
      for (const g of groups) g.tabs = g.tabs.map((t) => ({ ...t, input: { uri: t.input.uri } }));
      for (const { file, group = 0 } of extraTabs) {
        while (groups.length <= group) groups.push({ tabs: [] });
        groups[group].tabs.push({ id: newTabId(), input: { uri: Uri.file(file) }, isPreview: false });
      }
      listeners.groups.forEach((f) => f({ opened: [], closed: [], changed: groups.slice() }));
    },
    /** The VS Code window gets (or loses) the focus. */
    __windowFocus(focused) {
      listeners.windowState.forEach((f) => f({ focused, active: focused }));
    },
    __focus(file) {
      vscode.window.activeTextEditor = { document: makeDoc(file), selection: null, revealRange() {} };
    },
    /** A keystroke in `doc`: the text changes, the document turns dirty, auto save restarts its timer. */
    __type(doc, text) {
      doc.text += text;
      doc.version += 1;
      doc.isDirty = true;
      listeners.change.forEach((f) => f({ document: doc, contentChanges: [{ text }], reason: undefined }));
      scheduleAutoSave(doc);
    },
    /**
     * A save as the workbench performs it: takes __saveDelayMs, writes the
     * text it started with, clears the dirty flag only if nothing was typed
     * meanwhile, then reports the dirty flip as a change without content
     * changes. A write that fails (e.g. a read-only file) leaves the document
     * dirty in the error state and resolves false, like TextDocument.save().
     */
    __saveNow(doc, via) {
      // TextFileEditorModel.doSave: a save of the version already being written joins that write.
      if (doc.saving && doc.saving.version === doc.version) {
        saves.push({ file: doc.uri.fsPath, via, joined: true, start: Date.now(), end: Date.now() });
        return doc.saving.promise;
      }
      const version = doc.version;
      const promise = vscode.__write(doc, via).finally(() => {
        if (doc.saving && doc.saving.promise === promise) doc.saving = null;
      });
      doc.saving = { version, promise };
      return promise;
    },
    async __write(doc, via) {
      const file = doc.uri.fsPath;
      const entry = { file, via, start: Date.now(), end: null, failed: false };
      saves.push(entry);
      const running = (inFlight.get(file) || 0) + 1;
      inFlight.set(file, running);
      maxInFlight = Math.max(maxInFlight, running);
      const version = doc.version;
      const text = doc.text;
      await new Promise((r) => setTimeout(r, vscode.__saveDelayMs));
      try {
        fs.writeFileSync(file, text);
      } catch (err) {
        entry.failed = err.code || String(err);
      }
      inFlight.set(file, inFlight.get(file) - 1);
      entry.end = Date.now();
      if (entry.failed) {
        doc.saveError = true;
        return false;
      }
      doc.saveError = false;
      if (doc.version === version && doc.isDirty) {
        doc.isDirty = false;
        listeners.change.forEach((f) => f({ document: doc, contentChanges: [], reason: undefined }));
      }
      listeners.didSave.forEach((f) => f(doc));
      releaseIfUnused(doc);
      return true;
    },
    /**
     * Ctrl+Z back to the last saved version while the write of a newer one is
     * still in flight: VS Code reports the document clean at once (its version
     * id equals the saved one again), yet the disk ends up with the undone text.
     */
    __undoToSaved(doc, text) {
      doc.text = text;
      doc.version += 1;
      doc.isDirty = false;
      if (doc.autoSaveTimer) clearTimeout(doc.autoSaveTimer);
      doc.autoSaveTimer = null;
      listeners.change.forEach((f) => f({ document: doc, contentChanges: [{ text }], reason: 1 }));
    },
    /** A save started by the workbench itself (File > Save, Save All): onWillSave with reason, then onDidSave. */
    __save(doc, reason = 1) {
      listeners.willSave.forEach((f) => f({ document: doc, reason, waitUntil() {} }));
      fs.writeFileSync(doc.uri.fsPath, doc.text);
      doc.isDirty = false;
      saves.push({ file: doc.uri.fsPath, via: 'workbench', start: Date.now(), end: Date.now() });
      listeners.didSave.forEach((f) => f(doc));
    },
    __doc: makeDoc,
  };
  return vscode;
}

/**
 * Loads a fresh copy of src/scratch/extension.js against a fake vscode for `root`.
 * `before(vscode)` runs ahead of activation (tabs VS Code restored);
 * `logPath` is the host's context.logUri, which names its window:
 * <user data>/logs/<session>/window<N>/exthost/<extension id>.
 */
function loadExtension(root, { before, logPath = path.join(root, '.dev-logs', 'logs', '20261014T120000', 'window1', 'exthost', 'wiktormalyska.virga'), globalState = new Map() } = {}) {
  const vscode = createFakeVscode(root);
  if (before) before(vscode);
  const orig = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'vscode') return vscode;
    return orig.call(this, request, ...rest);
  };
  const extPath = require.resolve('../src/scratch/extension');
  delete require.cache[extPath];
  let ext;
  try {
    ext = require(extPath);
  } finally {
    Module._load = orig;
  }
  // globalState: a Map shared by the windows of one installation (context.globalState).
  const memento = {
    get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
    update: async (key, value) => {
      globalState.set(key, value);
    },
  };
  const context = { subscriptions: [], logUri: logPath ? vscode.Uri.file(logPath) : undefined, globalState: memento };
  vscode.__activating = true;
  let api;
  try {
    api = ext.activate(context);
  } finally {
    vscode.__activating = false;
  }
  return {
    vscode,
    ext,
    api,
    dispose: () => {
      for (const d of context.subscriptions) {
        try {
          d.dispose();
        } catch (err) {
          // ignore
        }
      }
    },
  };
}

module.exports = { loadExtension };
