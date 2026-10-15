'use strict';

// Dev-only: tokenizes text with the output grammar exactly like VS Code does,
// using the vscode-textmate + vscode-oniguruma copies bundled inside the
// installed VS Code (read straight out of node_modules.asar), and resolves
// token colors against real theme files. Nothing here ships in the VSIX.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE = path.join(__dirname, '..', '.dev-cache');
const GRAMMAR = path.join(__dirname, '..', 'syntaxes', 'virga-output.tmLanguage.json');
const SCOPE = 'source.virga-output';

function findVsCodeApp() {
  const candidates = [];
  if (process.env.VSCODE_APP_DIR) candidates.push(process.env.VSCODE_APP_DIR);
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Microsoft VS Code');
  try {
    for (const d of fs.readdirSync(base)) candidates.push(path.join(base, d, 'resources', 'app'));
  } catch (err) {
    // not installed per-user
  }
  candidates.push(path.join(base, 'resources', 'app'));
  return candidates.find((c) => fs.existsSync(path.join(c, 'node_modules.asar'))) || null;
}

function readAsar(asarPath, inner) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    let node = JSON.parse(json.toString('utf8'));
    for (const part of inner.split('/')) node = node.files[part];
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, 8 + headerSize + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1]; i += 1; } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** { name, colors, tokenColors } with "include" chains resolved (included rules first). */
function loadTheme(file) {
  const t = parseJsonc(fs.readFileSync(file, 'utf8'));
  let colors = {};
  let tokenColors = [];
  if (t.include) {
    const inc = loadTheme(path.resolve(path.dirname(file), t.include));
    colors = { ...inc.colors };
    tokenColors = inc.tokenColors.slice();
  }
  Object.assign(colors, t.colors || {});
  if (Array.isArray(t.tokenColors)) tokenColors.push(...t.tokenColors);
  return { name: t.name || path.basename(file), colors, tokenColors, type: t.type };
}

async function createHost() {
  const app = findVsCodeApp();
  if (!app) return null;
  fs.mkdirSync(CACHE, { recursive: true });
  const tmFile = path.join(CACHE, 'vscode-textmate.js');
  const onigFile = path.join(CACHE, 'vscode-oniguruma.js');
  if (!fs.existsSync(tmFile)) fs.writeFileSync(tmFile, readAsar(path.join(app, 'node_modules.asar'), 'vscode-textmate/release/main.js'));
  if (!fs.existsSync(onigFile)) fs.writeFileSync(onigFile, readAsar(path.join(app, 'node_modules.asar'), 'vscode-oniguruma/release/main.js'));
  const vsctm = require(tmFile);
  const onig = require(onigFile);
  const wasm = fs.readFileSync(path.join(app, 'node_modules.asar.unpacked', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new onig.OnigScanner(sources),
      createOnigString: (s) => new onig.OnigString(s),
    }),
    loadGrammar: async (scopeName) => (scopeName === SCOPE
      ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf8'), GRAMMAR)
      : null),
  });
  const grammar = await registry.loadGrammar(SCOPE);

  function tokenize(text) {
    let stack = vsctm.INITIAL;
    const lines = [];
    for (const line of String(text).split('\n')) {
      const r = grammar.tokenizeLine(line, stack);
      lines.push(r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes })));
      stack = r.ruleStack;
    }
    return lines;
  }

  /** Each token's resolved foreground under `theme`, the way the editor paints it. */
  function colorize(text, theme) {
    const dark = theme.type ? theme.type !== 'light' : !/light/i.test(theme.name);
    const defaultFg = theme.colors['editor.foreground'] || (dark ? '#D4D4D4' : '#000000');
    registry.setTheme({
      name: theme.name,
      settings: [{ settings: { foreground: defaultFg, background: theme.colors['editor.background'] || (dark ? '#1E1E1E' : '#FFFFFF') } }, ...theme.tokenColors],
    });
    const colorMap = registry.getColorMap();
    let stack = vsctm.INITIAL;
    const lines = [];
    for (const line of String(text).split('\n')) {
      const r = grammar.tokenizeLine2(line, stack);
      const toks = [];
      for (let i = 0; i < r.tokens.length; i += 2) {
        const start = r.tokens[i];
        const end = i + 2 < r.tokens.length ? r.tokens[i + 2] : line.length;
        const meta = r.tokens[i + 1];
        toks.push({
          text: line.slice(start, end),
          fg: String(colorMap[(meta & 16744448) >>> 15] || '').toUpperCase(),
          bold: ((meta & 30720) >>> 11 & 2) === 2,
        });
      }
      lines.push(toks);
      stack = r.ruleStack;
    }
    return { lines, defaultFg: String(colorMap[1] || defaultFg).toUpperCase() };
  }

  return { app, tokenize, colorize, loadTheme };
}

module.exports = { createHost, loadTheme, findVsCodeApp };
