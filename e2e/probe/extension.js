// Test only, loaded in the restore pass of ../run-e2e.mjs. Starts with VS Code
// ("*", as early as an extension can) and appends to VIRGA_E2E_PROBE
// one JSON line per thing another extension (say, Salesforce Code Analyzer)
// could act on: the scratch tabs at its start and after every tab change, and
// every editor or document of a scratch file, each with whether the file
// exists. The suite reports how long a scratch tab without a file was there.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SCRATCH = /[\\/]\.sfdx[\\/]virga-scratch[\\/]scratch-\d+\.(apex|soql)$/i;

function activate(context) {
  const out = process.env.VIRGA_E2E_PROBE;
  if (!out) return;
  const t0 = Date.now();
  const isScratch = (uri) => !!uri && uri.scheme === 'file' && SCRATCH.test(uri.fsPath);
  const describe = (uri) => ({ name: path.basename(uri.fsPath), exists: fs.existsSync(uri.fsPath) });
  const log = (event, extra) => {
    try {
      fs.appendFileSync(out, `${JSON.stringify({ t: Date.now() - t0, at: Date.now(), event, ...extra })}\n`);
    } catch (err) {
      // the run goes on without the probe
    }
  };
  const tabs = () => vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .map((t) => t.input && t.input.uri)
    .filter(isScratch)
    .map(describe);
  const editor = (e) => (e && isScratch(e.document.uri) ? describe(e.document.uri) : null);

  log('activate', { tabs: tabs(), activeEditor: editor(vscode.window.activeTextEditor), documents: vscode.workspace.textDocuments.map((d) => d.uri).filter(isScratch).map(describe) });
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => log('tabs', { tabs: tabs() })),
    vscode.window.tabGroups.onDidChangeTabGroups(() => log('groups', { tabs: tabs() })),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      const d = editor(e);
      if (d) log('activeEditor', d);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isScratch(doc.uri)) log('openDocument', describe(doc.uri));
    }),
  );
}

module.exports = { activate, deactivate() {} };
