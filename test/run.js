'use strict';

// npm test: every test/*.test.js in its own Node process (each file has its
// own small runner and fake vscode module), one after the other, with one
// summary at the end. Environment variables reach every file:
//   ONLY=<regex>            just the tests whose name matches (in every file)
//   VIRGA_TEST_ORG=<alias>  also the scratch tests that run sf against that org
//   SKIP_ORG=1              never the org tests

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort();
const results = [];
for (const name of files) {
  console.log(`\n### ${name}\n`);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit', windowsHide: true });
  results.push({ name, code: res.status === null ? 1 : res.status, s: ((Date.now() - t0) / 1000).toFixed(1) });
}
console.log('\n### summary\n');
for (const r of results) console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name} (${r.s} s)`);
const failed = results.filter((r) => r.code !== 0).length;
console.log(failed ? `\n${failed} of ${results.length} test files failed` : `\nall ${results.length} test files passed`);
process.exit(failed ? 1 : 0);
