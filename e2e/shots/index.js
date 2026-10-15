// Runs inside the isolated VS Code started by ../run-e2e.mjs with ONLY_SHOTS=1
// and takes the three README screenshots: a scratch run with its colored
// output, the local-type completion list, and the raw-List diagnostic with its
// quick fix. sf is the stand-in in ./fake-sf, the org alias is made up. Keys
// and text go in through the Chrome DevTools protocol like in ../suite; the
// window is captured by ../capture-window.ps1 (run-e2e.mjs answers the
// requests written to VIRGA_E2E_SHOTS_DIR). Results go to VIRGA_E2E_OUT.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const OUT = process.env.VIRGA_E2E_OUT;
const IPC = process.env.VIRGA_E2E_IPC;
const SHOTS = process.env.VIRGA_E2E_SHOTS_DIR;
const ORG = process.env.VIRGA_TEST_ORG;
// Logical size of the window in the screenshots (CSS pixels; the capture is in device pixels).
const WIDTH = 1180;
const HEIGHT = 720;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });

async function waitFor(fn, timeout = 20000, every = 100) {
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

let inputSeq = 0;
/** Plays [{text}|{key}|{waitMs}|{evaluate}] through the DevTools protocol (run-e2e.mjs). */
async function input(steps) {
  inputSeq += 1;
  const req = path.join(IPC, `input-${inputSeq}.json`);
  fs.writeFileSync(`${req}.tmp`, JSON.stringify({ steps }));
  fs.renameSync(`${req}.tmp`, req);
  const resFile = path.join(IPC, `inputres-${inputSeq}.json`);
  const res = await waitFor(() => (fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')) : null), 30000, 10);
  if (!res || !res.ok) throw new Error(`input ${inputSeq}: ${res ? res.error : 'no answer'}`);
  return res;
}

/** Asks run-e2e.mjs for `request-<name>` (options as the file's JSON) and waits for its done file. */
async function request(name, opts = {}) {
  const done = path.join(SHOTS, `done-${name}`);
  fs.rmSync(done, { force: true });
  fs.writeFileSync(path.join(SHOTS, `request-${name}`), JSON.stringify(opts));
  const ok = await waitFor(() => fs.existsSync(done), 30000, 100);
  return ok ? fs.readFileSync(done, 'utf8').trim() : 'no answer';
}

// Device pixels of the title bar, left out of every screenshot: it would say
// "[Extension Development Host]", which no user sees.
let cropTop = 0;

async function shot(name) {
  await vscode.commands.executeCommand('notifications.clearAll'); // the Extension Pack hint, VS Code's own toasts
  await sleep(700);
  const msg = await request(name, { cropTop });
  check(`screenshot ${name}: ${msg}`, /^ok \d+x\d+$/.test(msg) && fs.existsSync(path.join(SHOTS, `${name}.png`)), msg);
}

async function setText(editor, text) {
  const doc = editor.document;
  await editor.edit((eb) => eb.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
}

const SCRIPT = [
  `// Ctrl+S runs this in ${ORG}. Close the tab to discard.`,
  '',
  'List<Account> accounts = [',
  '    SELECT Id, Name, Industry FROM Account',
  '    WHERE Industry != null ORDER BY Name LIMIT 3',
  '];',
  "System.debug(accounts.size() + ' accounts with an industry');",
  'for (Account a : accounts) {',
  '    System.debug(LoggingLevel.INFO, a);',
  '}',
  "System.debug(LoggingLevel.WARN, Limits.getQueries() + ' of 100 queries used');",
  '',
].join('\n');

const CLASS = (signature, body) => [
  'public with sharing class OrderIntake {',
  "    @InvocableMethod(label='Take orders' description='Accepts or rejects each order.')",
  `    public static List<Result> take(${signature}) {`,
  '        List<Result> results = new List<Result>();',
  ...body,
  '        return results;',
  '    }',
  '',
  '    public class Request {',
  '        @InvocableVariable(required=true) public String orderNumber;',
  '    }',
  '',
  '    public class Result {',
  '        @InvocableVariable public Boolean accepted;',
  '    }',
  '}',
  '',
].join('\n');

async function scratchShot(api) {
  const uri = await vscode.commands.executeCommand('virga.scratch.newApex');
  const editor = vscode.window.activeTextEditor;
  check('scratch opened', uri && editor && editor.document.uri.fsPath === uri.fsPath);
  await setText(editor, SCRIPT);
  const end = editor.document.positionAt(editor.document.getText().length);
  editor.selection = new vscode.Selection(end, end);
  await sleep(400);
  const runs = api.stats().runs;
  await input([{ key: 'ctrl+s' }]);
  await waitFor(() => api.stats().runs > runs, 10000, 50);
  await api.whenIdle();
  const text = api.outputText() || '';
  check('the run printed the fake org header and the debug lines', text.includes(`▶ Apex · ${ORG} · `) && /\[line 9\] +INFO/.test(text) && text.includes('Limits'), text);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  editor.selection = new vscode.Selection(end, end);
  await shot('scratch-run');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

async function completionShot(file) {
  fs.writeFileSync(file, CLASS('List<Request> requests', [
    '        for (Request req : requests) {',
    '            results.add(new );',
    '        }',
  ]));
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  check('the class is an apex document', doc.languageId === 'apex', doc.languageId);
  const line = 5;
  const col = doc.lineAt(line).text.indexOf('new ') + 4;
  editor.selection = new vscode.Selection(line, col, line, col);
  await sleep(500);
  await input([{ text: 'R' }, { waitMs: 120 }, { text: 'e' }, { waitMs: 120 }, { text: 's' }, { waitMs: 1200 }]);
  const items = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, editor.selection.active);
  const labels = (items && items.items ? items.items : []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  check('Request and Result offered with "inner class of OrderIntake"', labels.includes('Request') && labels.includes('Result') && items.items.some((i) => i.detail === 'inner class of OrderIntake'), labels);
  await shot('local-type-completion');
  await input([{ key: 'escape' }]);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

async function quickFixShot(file) {
  fs.writeFileSync(file, CLASS('List requests', []));
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const diags = await waitFor(() => {
    const d = vscode.languages.getDiagnostics(doc.uri).filter((x) => x.source === 'virga');
    return d.length ? d : null;
  }, 10000, 100);
  check('the raw List gets the virga diagnostic', diags && diags[0].code === 'jorje-crash', diags);
  if (!diags) return;
  await vscode.commands.executeCommand('workbench.actions.view.problems');
  await sleep(600);
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  const at = diags[0].range.start;
  editor.selection = new vscode.Selection(at.line, at.character + 2, at.line, at.character + 2);
  await sleep(300);
  await vscode.commands.executeCommand('editor.action.quickFix');
  await sleep(1200);
  const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', doc.uri, diags[0].range, vscode.CodeActionKind.QuickFix.value);
  const titles = (actions || []).map((a) => a.title);
  check('quick fix "Change to List<Request> requests" offered', titles.includes('Change to List<Request> requests'), titles);
  await shot('raw-list-quick-fix');
  await input([{ key: 'escape' }]);
}

/** The contributed snippets reach real editors: Apex annotations after "@", user mode in .soql. */
async function snippetChecks(ws, classFile) {
  const doc = await vscode.workspace.openTextDocument(classFile);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await setText(editor, CLASS('List<Request> requests', ['        @Inv']));
  const line = 4;
  const pos = new vscode.Position(line, doc.lineAt(line).text.length);
  const snippetLabels = async (d, p) => {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', d.uri, p);
    return (list && list.items ? list.items : []).filter((i) => i.kind === vscode.CompletionItemKind.Snippet).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  };
  const apex = await snippetLabels(doc, pos);
  check('apex snippets: "@Inv" offers the InvocableMethod and InvocableVariable snippets', apex.includes('InvocableMethod') && apex.includes('InvocableVariable'), apex);
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  const soqlFile = path.join(ws, 'scripts', 'soql', 'accounts.soql');
  fs.mkdirSync(path.dirname(soqlFile), { recursive: true });
  fs.writeFileSync(soqlFile, 'SELECT Id FROM Account WITH user_\n');
  const soql = await vscode.workspace.openTextDocument(soqlFile);
  await vscode.window.showTextDocument(soql, { preview: false });
  const soqlSnippets = await snippetLabels(soql, new vscode.Position(0, soql.lineAt(0).text.length));
  check('soql snippets: "WITH user_" offers the user-mode snippet in a .soql file', soql.languageId === 'soql' && soqlSnippets.some((l) => /^(user_mode|WITH USER_MODE|USER_MODE)$/.test(l)), { languageId: soql.languageId, soqlSnippets });
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

async function run() {
  try {
    await sleep(1500);
    const ext = vscode.extensions.getExtension('wiktormalyska.virga');
    check('extension found', !!ext);
    const api = await ext.activate();
    const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    const dpr = (await input([{ evaluate: 'window.devicePixelRatio' }])).values[0] || 1;
    const resized = await request(`resize@${Math.round(WIDTH * dpr)}x${Math.round(HEIGHT * dpr)}`);
    check(`window resized (${dpr}x): ${resized}`, /^resized/.test(resized), resized);
    await sleep(1000);
    const titleBar = (await input([{ evaluate: "(() => { const t = document.querySelector('.part.titlebar'); return t ? t.getBoundingClientRect().height : 0; })()" }])).values[0] || 0;
    cropTop = Math.round(titleBar * dpr);

    await scratchShot(api);
    const classes = path.join(ws, 'force-app', 'main', 'default', 'classes');
    fs.mkdirSync(classes, { recursive: true });
    const file = path.join(classes, 'OrderIntake.cls');
    await completionShot(file);
    await quickFixShot(file);
    await snippetChecks(ws, file);
  } catch (err) {
    results.push({ name: 'screenshot suite (threw)', ok: false, detail: String((err && err.stack) || err) });
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  return { closedWindow: false };
}

module.exports = { run };
