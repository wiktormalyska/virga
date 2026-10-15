'use strict';

// Virga's local types: a thin adapter between VS Code and lib.js. Adds
// completion items for type names declared in the current Apex file, which
// the Apex language server (jorje) does not offer, and flags the signatures
// that break its member completion (raw List in an @InvocableMethod, a raw
// List return type, ...) with a quick fix. All logic lives in lib.js.

const vscode = require('vscode');
const lib = require('./lib');

// Same selector score as the Apex language server, so VS Code merges both
// lists instead of showing only the higher-scored provider.
const SELECTOR = [
  { language: 'apex', scheme: 'file' },
  { language: 'apex', scheme: 'untitled' },
];

const MAX_CACHED_DOCUMENTS = 16;
const DIAGNOSTIC_SOURCE = 'virga';
// Diagnostics wait for a pause in typing: "List<Req" is a crash shape too,
// but nobody needs to see it flash between two keystrokes.
const DEBOUNCE_MS = 400;

// uri -> { version, text, analysis, breakers }. The text is kept with its
// analysis so offsets and regions always describe the same snapshot.
const cache = new Map();
// uri -> pending diagnostics refresh
const timers = new Map();
let diagnostics = null;

function snapshot(document) {
  const key = document.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === document.version) return hit;
  const text = document.getText();
  const entry = { version: document.version, text, analysis: lib.analyze(text), breakers: null };
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHED_DOCUMENTS) cache.delete(cache.keys().next().value);
  return entry;
}

function breakersOf(entry) {
  if (entry.breakers === null) entry.breakers = lib.findCompletionBreakers(entry.text, entry.analysis);
  return entry.breakers;
}

// .cls files and untitled Apex buffers. Anonymous Apex (apex-anon) has no
// method declarations to check. Files under .sfdx/ (the generated
// StandardApexLibrary stubs and typings) are Salesforce's read-only copies:
// nothing to fix there, so they get no diagnostics.
function isApexDocument(document) {
  if (!document || document.languageId !== 'apex' || !document.uri) return false;
  const uri = document.uri;
  if (uri.scheme === 'untitled') return true;
  return uri.scheme === 'file' && !isGeneratedPath(uri.path);
}

function isGeneratedPath(path) {
  return typeof path === 'string' && path.replace(/\\/g, '/').toLowerCase().includes('/.sfdx/');
}

// jorje serves only file: documents, and for those it already offers the
// file's own top-level class (Foo.cls -> Foo) from its workspace index.
// Untitled buffers get no help from it, so they keep that item.
function ownTypeName(document) {
  const uri = document.uri;
  if (!uri || uri.scheme !== 'file') return null;
  return lib.typeNameFromPath(uri.path);
}

function wordStartOnly(document) {
  try {
    return vscode.workspace.getConfiguration('editor.suggest', document)
      .get('matchOnWordStartOnly', true) !== false;
  } catch (err) {
    return true;
  }
}

function itemKind(kind) {
  switch (kind) {
    case 'interface': return vscode.CompletionItemKind.Interface;
    case 'enum': return vscode.CompletionItemKind.Enum;
    default: return vscode.CompletionItemKind.Class;
  }
}

const provider = {
  provideCompletionItems(document, position, token) {
    try {
      if (token && token.isCancellationRequested) return undefined;
      const entry = snapshot(document);
      const offset = document.offsetAt(position);
      const found = lib.completionCandidates(entry.text, offset, entry.analysis, {
        ownTypeName: ownTypeName(document),
        wordStartOnly: wordStartOnly(document),
      });
      // Nothing to add: return undefined, not [], so VS Code can still fall
      // back to word-based suggestions when no other provider has items.
      if (found.length === 0) return undefined;
      return found.map((c) => {
        const item = new vscode.CompletionItem(c.name, itemKind(c.kind));
        item.detail = c.detail;
        item.sortText = c.sortText;
        return item;
      });
    } catch (err) {
      return undefined;
    }
  },
};

function toRange(document, start, end) {
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function refresh(document) {
  try {
    if (diagnostics === null || !isApexDocument(document)) return;
    const entry = snapshot(document);
    diagnostics.set(document.uri, breakersOf(entry).map((b) => {
      const d = new vscode.Diagnostic(toRange(document, b.start, b.end), b.message, vscode.DiagnosticSeverity.Error);
      d.source = DIAGNOSTIC_SOURCE;
      d.code = b.code;
      return d;
    }));
  } catch (err) {
    // A broken check must never take the editor down with it.
  }
}

function schedule(document, delay) {
  try {
    if (!isApexDocument(document)) return;
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      refresh(document);
    }, delay));
  } catch (err) {
    // nothing scheduled
  }
}

// Quick fixes for our own diagnostics, recomputed on the current text so an
// edit always matches the document it is applied to.
const actions = {
  provideCodeActions(document, range, context) {
    try {
      if (!isApexDocument(document)) return undefined;
      const ours = ((context && context.diagnostics) || []).filter((d) => d.source === DIAGNOSTIC_SOURCE);
      if (ours.length === 0) return undefined;
      const breakers = breakersOf(snapshot(document));
      const out = [];
      for (const d of ours) {
        const start = document.offsetAt(d.range.start);
        const b = breakers.find((x) => x.start === start);
        if (!b) continue;
        for (const fix of b.fixes) {
          const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, toRange(document, fix.edit.start, fix.edit.end), fix.edit.newText);
          action.edit = edit;
          action.diagnostics = [d];
          action.isPreferred = fix.preferred;
          out.push(action);
        }
      }
      return out.length > 0 ? out : undefined;
    } catch (err) {
      return undefined;
    }
  },
};

function forget(document) {
  try {
    const key = document.uri.toString();
    cache.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (diagnostics !== null) diagnostics.delete(document.uri);
  } catch (err) {
    // nothing to clean up
  }
}

function activate(context) {
  try {
    diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
    context.subscriptions.push(
      diagnostics,
      vscode.languages.registerCompletionItemProvider(SELECTOR, provider),
      vscode.languages.registerCodeActionsProvider(SELECTOR, actions, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.workspace.onDidOpenTextDocument((document) => schedule(document, 0)),
      vscode.workspace.onDidChangeTextDocument((event) => schedule(event && event.document, DEBOUNCE_MS)),
      vscode.workspace.onDidCloseTextDocument(forget),
    );
    // Apex files already open when the extension activated.
    for (const document of vscode.workspace.textDocuments || []) schedule(document, 0);
  } catch (err) {
    // A broken registration must never take the editor down with it.
  }
}

function deactivate() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  cache.clear();
  diagnostics = null;
}

module.exports = { activate, deactivate, provider, actions, refresh, SELECTOR, DEBOUNCE_MS, DIAGNOSTIC_SOURCE };
