# Changelog

All notable changes to Virga are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-15

Initial release.

### Added

- **Apex and SOQL scratches.** Status bar buttons open throwaway
  `scratch-<n>.apex` / `scratch-<n>.soql` tabs in a Salesforce DX project
  (files in `.sfdx/virga-scratch/`, so the Apex and SOQL language servers work
  in them).
- **Ctrl+S runs a scratch** (Cmd+S on macOS) in the project's default org with
  `sf apex run` / `sf data query`, using the text shown in the editor at that
  moment. Only Ctrl+S in the scratch, the run button in its title or
  **Virga: Run Scratch** runs it; saves never do. One run at a time, a second
  Ctrl+S is queued. The binding outranks the IntelliJ IDEA keymap's Ctrl+S
  (Save All) in scratch editors only.
- **Colored output** in the **Virga** output channel: compile errors and
  exceptions with the source line and a caret, stack traces, every debug line
  with its level, limits; SOQL results as a table with flattened relationship
  fields, subquery counts and truncated long values.
- **Closing a scratch discards it** without a "save changes?" question (short
  auto save as the `apex-anon` / `soql` language default, with retries when a
  background save fails). Restored, orphaned and externally deleted scratches
  are cleaned up; two windows on one project never delete each other's
  scratches.
- **Completion of types declared in the current Apex file** (top-level and
  inner classes, interfaces, enums), which the Apex language server does not
  offer.
- **Diagnostics and quick fixes for signatures that break the Apex language
  server's member completion**: raw or incomplete collection types in
  `@InvocableMethod`, `@AuraEnabled`, `@Http*`, `webservice` and `global`
  signatures, raw collection return types and cut-off parameters.
- **Apex snippets** for what the Salesforce Extension Pack's own snippets do
  not cover: annotations (inserted after a typed `@`), keywords and modifiers
  such as `return`, `break`, `else if` and `with sharing`, DML statements,
  user- and system-mode DML and `Database.queryWithBinds`; `WITH USER_MODE` /
  `WITH SYSTEM_MODE` for Apex and `.soql` files. No prefix repeats one of the
  pack's, so no suggestion shows up twice.
- **No telemetry.** Virga sends nothing, and the `sf` runs it starts have
  `sf`'s own usage telemetry turned off (`SF_DISABLE_TELEMETRY=true`).
- Settings `virga.scratch.timeoutSeconds`, `virga.scratch.maxColumnWidth`,
  `virga.scratch.clearOutputOnRun`.
- A one-time hint when a scratch is created without the Salesforce Extension
  Pack's language support; no hard dependency on it.

[0.1.0]: https://github.com/wiktormalyska/virga/releases/tag/v0.1.0
