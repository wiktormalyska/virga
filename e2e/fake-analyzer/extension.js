// Test only, loaded in the restart pass of ../run-e2e.mjs. Does what Salesforce
// Code Analyzer (1.22) does with codeAnalyzer.analyzeOnOpen.enabled: when an
// editor of a file whose extension is in its default
// codeAnalyzer.analyzeAutomatically.fileTypes becomes active, it checks the
// path (fromTargetPaths), runs the code-analyzer CLI on it, which reads the
// file a while later (here: VIRGA_E2E_ANALYZER_MS), and shows
// "Analysis failed: ... The file or folder '<path>' does not exist." when the
// file is gone by then (displayError). Every scan is logged to
// VIRGA_E2E_ANALYZER, one JSON line when it starts and one when it ends.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const FILE_TYPES = ['.cls', '.js', '.apex', '.trigger', '.ts', '.xml'];

function activate(context) {
  const out = process.env.VIRGA_E2E_ANALYZER;
  if (!out) return;
  const scanMs = Number(process.env.VIRGA_E2E_ANALYZER_MS) || 8000;
  const log = (event, extra) => {
    try {
      fs.appendFileSync(out, `${JSON.stringify({ at: Date.now(), event, ...extra })}\n`);
    } catch (err) {
      // the run goes on without the log
    }
  };
  const analyze = (editor) => {
    const uri = editor && editor.document && editor.document.uri;
    if (!uri || uri.scheme !== 'file' || !FILE_TYPES.includes(path.extname(uri.fsPath).toLowerCase())) return;
    const file = uri.fsPath;
    if (!fs.existsSync(file)) {
      log('skipped', { file }); // fromTargetPaths: nothing to analyze
      return;
    }
    log('start', { file });
    setTimeout(() => {
      if (fs.existsSync(file)) {
        log('done', { file, found: true });
        return;
      }
      log('done', { file, found: false });
      vscode.window.showErrorMessage(`Analysis failed: Error (1): The file or folder '${file}' does not exist.`);
    }, scanMs);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => analyze(e)));
  analyze(vscode.window.activeTextEditor);
}

module.exports = { activate, deactivate() {} };
