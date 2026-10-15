# Development notes

## Layout

| Path | What it is |
|---|---|
| `extension.js` | entry point: activates both parts, each in its own `try` |
| `src/scratch/extension.js` | scratch tabs, the run command, status bar, output channel, cleanup |
| `src/scratch/lib.js` | scratch paths, owner files of windows, locating and spawning `sf`, parsing its JSON and the Apex debug log, the output text and tables |
| `src/local-types/extension.js` | completion provider, diagnostics and quick fixes for `apex` documents |
| `src/local-types/lib.js` | the Apex scanner: declared types, completion context, signatures that break completion and their fixes |
| `syntaxes/virga-output.tmLanguage.json` | colors of the output channel |
| `snippets/*.code-snippets` | Apex and SOQL snippets |
| `test/` | unit tests (plain Node), fakes of the VS Code API, recorded `sf` output |
| `e2e/` | the scratch in a real VS Code, on a hidden desktop |
| `tools/render-icon.ps1` | `images/icon.svg` → `images/icon.png` |
| `tools/record-pack-snippets.js` | records the snippet prefixes of the Salesforce Extension Pack in `test/fixtures/sf-pack-snippets.json` |

Both `lib.js` files are pure functions without `vscode`, so they are tested
directly. No npm dependencies, no build step.

## Unit tests

`npm test` runs every `test/*.test.js` in its own Node process:

- `scratch.test.js`: formatters on recorded `sf` output (`test/fixtures`, record
  ids and names replaced by synthetic ones), `sf` lookup and spawning through
  real `.cmd` shims with awkward folder names, owner files, and
  `src/scratch/extension.js` itself in `test/fake-vscode.js`, which copies the
  VS Code behavior the extension depends on: auto save as a debounce, a short
  auto save counting as "being saved", failed saves, the "save changes?"
  prompt, restored tabs before activation, `tabGroups.close` with stale tabs,
  several windows on one project. The output grammar is tokenized with the
  TextMate engine of an installed VS Code (skipped when there is none) and
  checked against real themes.
- `local-types.test.js`: the scanner and the adapter on a fake `vscode`.
- `package.test.js`: manifest ids, the entry point, snippets, what the VSIX
  ships, and a scan for personal data. No snippet prefix may be one the
  Salesforce Extension Pack already uses for the same language (it ships
  snippets for `if`, `for`, `try`, `class` and more in
  `salesforce.apex-language-server-extension`), or the suggestion list shows
  two items with the same name. The test compares against the prefixes
  recorded in `test/fixtures/sf-pack-snippets.json` and, when the pack is
  installed in `~/.vscode/extensions`, against that copy too. After a new pack
  release: `node tools/record-pack-snippets.js`, then `npm test`.

Environment variables: `ONLY=<regex>` runs the matching tests,
`VIRGA_TEST_ORG=<alias>` adds the org tests (anonymous Apex with
`System.debug` and SOQL queries only), `SKIP_ORG=1` never runs them,
`VIRGA_INTELLIJ_KEYMAP=<folder>` points the keybinding test at a copy of the
IntelliJ IDEA keymap extension (installed copies are checked anyway).

## End-to-end (Windows)

`npm run e2e` runs `e2e/e2e.ps1`: the self-test of `e2e/hidden-desktop.ps1`,
then `e2e/run-e2e.mjs` on a separate desktop that is never shown, so the
VS Code windows it opens never appear on screen or take the focus. Never start
it any other way.

`run-e2e.mjs` starts VS Code with its own `--user-data-dir` and
`--extensions-dir` under `e2e/`, Virga from the source folder (`FROM_VSIX=1`,
`npm run e2e:vsix`: installed from `virga-<version>.vsix`), `e2e/fake-sf-langs`
(the Salesforce language ids without language servers) and `e2e/driver`, which
runs `e2e/suite` in a normal window and quits. Not `--extensionTestsPath`: in
extension test mode VS Code answers its own "save changes?" dialog without
showing it. `e2e/dialog-watch.ps1` logs and dismisses every native dialog of
that VS Code, so a dialog fails the run instead of hanging it. Typed text and
keys go in through the Chrome DevTools protocol, so the real keymap decides
what Ctrl+S does.

The default keymap pass also loads `e2e/.cache/sf-snippets`, a stand-in that
contributes the Extension Pack's Apex and SOQL snippets exactly as the pack
does (its snippet files copied from the installed pack, never committed; or,
without one, placeholders built from the recorded prefixes). The suite types
every prefix of either side in a class and in a `.soql` file and checks that
no label is listed by both.

Passes: the default keymap (everything), the IntelliJ IDEA keymap (the key
checks; `SKIP_INTELLIJ=1`), a restart with three scratches open and one file
deleted in between (`SKIP_RESTORE=1`; `e2e/probe` logs what other extensions
see, `e2e/fake-analyzer` reads files late like Code Analyzer's analysis on
open), and two windows on one project, folder and `.code-workspace`, with a
**Reload Window** in the middle (`SKIP_MULTI=1`).

VS Code binary: `VSCODE_EXE` when it is set, else `e2e/vsc/Code.exe` when
present (a copy, or a junction made with `mklink /J` to one), else the
installed VS Code. So with both, `VSCODE_EXE` wins: unset it to test the copy
in `e2e/vsc`. Any binary other than the installed one counts as a copy and
gets its own `urlProtocol` in `product.json`, or every start would make it the
handler of `vscode://` links; give a copy its own `win32MutexName` too, or a
pending update of the installed VS Code keeps it from starting. A copy in a
path past 260 characters cannot load the tokenizer worker, so the test profile
sets `editor.experimental.asyncTokenization: false`.

## Screenshots

`npm run screenshots` runs the same launcher with `ONLY_SHOTS=1`: `e2e/shots`
drives the window, `e2e/shots/fake-sf` stands in for `sf` (no org), and
`e2e/capture-window.ps1` captures the window without its title bar. When the
Salesforce extensions are installed in `~/.vscode/extensions`, their TextMate
grammars are borrowed for the run (copied to `e2e/.cache`, never committed) so
the code is highlighted. The three PNGs are copied to `images/` only when all
of them were taken.
