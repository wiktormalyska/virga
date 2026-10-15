// Runs the e2e suite (VIRGA_E2E_SUITE) once the window has started,
// then quits VS Code. Loaded as a development extension instead of passing
// --extensionTestsPath: in extension-test mode VS Code answers its own
// "save changes?" dialog with "Don't Save" without showing it, so a test there
// could never see the dialog this extension must not cause.
const vscode = require('vscode');

function activate() {
  setTimeout(async () => {
    let closedWindow = false;
    try {
      const suite = require(process.env.VIRGA_E2E_SUITE);
      const res = await suite.run();
      closedWindow = !!(res && res.closedWindow);
    } catch (err) {
      // the suite has written its results (and the crash) already
    }
    if (!closedWindow) await vscode.commands.executeCommand('workbench.action.quit');
  }, 1000);
}

module.exports = { activate, deactivate() {} };
