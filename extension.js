'use strict';

// Virga's entry point. Two independent parts share one extension host:
// - src/scratch: throwaway anonymous Apex / SOQL tabs that Ctrl+S runs with sf;
// - src/local-types: completion of types declared in the open Apex file, and
//   the diagnostic + quick fix for signatures that break the Apex language
//   server's member completion.
// Each keeps its own state; a failure in one never stops the other. Activation
// is lazy (package.json: a Salesforce DX workspace, an Apex file, or one of the
// commands) and does no I/O beyond looking for sfdx-project.json in the
// workspace folders.

const scratch = require('./src/scratch/extension');
const localTypes = require('./src/local-types/extension');

function activate(context) {
  let api;
  try {
    api = scratch.activate(context);
  } catch (err) {
    console.error('[virga] scratch part failed to start:', err);
  }
  try {
    localTypes.activate(context);
  } catch (err) {
    console.error('[virga] local types part failed to start:', err);
  }
  // The scratch part's small API (used by the end-to-end tests); nothing else is exported.
  return api;
}

function deactivate() {
  try {
    scratch.deactivate();
  } finally {
    localTypes.deactivate();
  }
}

module.exports = { activate, deactivate };
