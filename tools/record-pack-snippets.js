'use strict';

// Records the snippet prefixes of the Salesforce Extension Pack in
// test/fixtures/sf-pack-snippets.json. Virga does not repeat a snippet the pack
// already ships (two items with the same label in one suggestion list), and
// test/package.test.js and the e2e check that against this recording.
//
// Only the extension that contributes Apex and SOQL snippets is read:
// salesforce.apex-language-server-extension. Prefixes and the
// language/path pairs of contributes.snippets are kept, never the bodies.
//
//   node tools/record-pack-snippets.js            newest copy in ~/.vscode/extensions
//   node tools/record-pack-snippets.js <folder>   that extension folder
//
// Run it when a new Extension Pack ships, then npm test.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = 'salesforce.apex-language-server-extension';
const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'sf-pack-snippets.json');

/** The newest installed copy of the extension, or null. */
function findInstalled(dir = path.join(os.homedir(), '.vscode', 'extensions')) {
  try {
    const found = fs.readdirSync(dir)
      .filter((d) => d.startsWith(`${ID}-`) && /^\d+\.\d+\.\d+$/.test(d.slice(ID.length + 1)))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .pop();
    return found ? path.join(dir, found) : null;
  } catch (err) {
    return null;
  }
}

/** { extension, version, snippets: [{ language, path }], prefixes: { path: [prefix] } } of an extension folder. */
function readPackSnippets(folder) {
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
  const snippets = ((pkg.contributes && pkg.contributes.snippets) || []).map((s) => ({ language: s.language, path: s.path }));
  const prefixes = {};
  for (const p of new Set(snippets.map((s) => s.path))) {
    const file = JSON.parse(fs.readFileSync(path.join(folder, p), 'utf8'));
    prefixes[p] = [...new Set(Object.values(file).flatMap((s) => [].concat(s.prefix || [])))];
  }
  return { extension: `${pkg.publisher}.${pkg.name}`, version: pkg.version, snippets, prefixes };
}

/** "salesforce.salesforcedx-vscode <version>" of the newest pack next to it that lists the extension, or null. */
function findPack(dir) {
  const PACK = 'salesforce.salesforcedx-vscode';
  try {
    const found = fs.readdirSync(dir)
      .filter((d) => d.startsWith(`${PACK}-`) && /^\d+\.\d+\.\d+$/.test(d.slice(PACK.length + 1)))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .pop();
    if (!found) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, found, 'package.json'), 'utf8'));
    return (pkg.extensionPack || []).includes(ID) ? `${PACK} ${pkg.version}` : null;
  } catch (err) {
    return null;
  }
}

if (require.main === module) {
  const folder = process.argv[2] ? path.resolve(process.argv[2]) : findInstalled();
  if (!folder || !fs.existsSync(path.join(folder, 'package.json'))) {
    console.error(`${ID} not found: install the Salesforce Extension Pack or pass the extension folder`);
    process.exit(2);
  }
  const rec = readPackSnippets(folder);
  if (rec.extension !== ID) {
    console.error(`${folder} is ${rec.extension}, not ${ID}`);
    process.exit(2);
  }
  const pack = findPack(path.dirname(folder));
  fs.writeFileSync(OUT, `${JSON.stringify(pack ? { pack, ...rec } : rec, null, 2)}\n`);
  const count = Object.values(rec.prefixes).reduce((n, list) => n + list.length, 0);
  console.log(`${path.relative(process.cwd(), OUT)}: ${rec.extension} ${rec.version}, ${count} prefixes`);
}

module.exports = { ID, findInstalled, readPackSnippets };
