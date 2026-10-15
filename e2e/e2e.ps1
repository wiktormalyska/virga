# npm run e2e | e2e:vsix | screenshots
# Runs e2e/run-e2e.mjs on a hidden Windows desktop (hidden-desktop.ps1), so no
# VS Code window ever shows up on your screen or takes the focus. The launcher's
# self-test runs first; if it fails, nothing is started.
#   -FromVsix     test the packaged virga-<version>.vsix (npm run package first)
#   -Screenshots  take the README screenshots (fake sf, no org) into images/
# The scratch e2e needs VIRGA_TEST_ORG (an org authorized in sf); the
# screenshots do not. Output goes to a log in the repository root, whose tail
# is printed at the end.
param([switch]$FromVsix, [switch]$Screenshots)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'hidden-desktop.ps1'
$shell = (Get-Process -Id $PID).Path

& $shell -NoProfile -ExecutionPolicy Bypass -File $launcher -SelfTest
if ($LASTEXITCODE -ne 0) { Write-Error 'hidden desktop self-test failed: no VS Code is started'; exit 1 }

if ($FromVsix) { $env:FROM_VSIX = '1' }
if ($Screenshots) { $env:ONLY_SHOTS = '1' }
$name = 'e2e-out.log'
if ($FromVsix) { $name = 'e2e-vsix-out.log' }
if ($Screenshots) { $name = 'e2e-shots.log' }
$log = Join-Path $root $name

$node = (Get-Command node -ErrorAction Stop).Source
$cmd = "cmd.exe /c `"`"$node`" e2e\run-e2e.mjs > `"$log`" 2>&1`""
# In this session, not through powershell.exe: a native command line would split $cmd at its quotes.
& $launcher -WorkingDirectory $root -CommandLine $cmd
$code = $LASTEXITCODE
if (Test-Path $log) { Get-Content $log -Tail 80 }
Write-Output "run-e2e exit code $code (full log: $log)"
exit $code
