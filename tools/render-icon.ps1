# Renders images/icon.svg into images/icon.png (128x128, transparent corners)
# with headless Chrome or Edge, started on the hidden desktop of
# e2e/hidden-desktop.ps1 like every other program here that could open a window.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/render-icon.ps1
param([int]$Size = 128)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$svg = Join-Path $root 'images\icon.svg'
$png = Join-Path $root 'images\icon.png'
$launcher = Join-Path $root 'e2e\hidden-desktop.ps1'
$shell = (Get-Process -Id $PID).Path
$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge not found' }

& $shell -NoProfile -ExecutionPolicy Bypass -File $launcher -SelfTest
if ($LASTEXITCODE -ne 0) { throw 'hidden desktop self-test failed: nothing started' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) "virga-icon-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    $html = Join-Path $tmp 'icon.html'
    $svgUri = ([Uri]$svg).AbsoluteUri
    Set-Content -Path $html -Encoding UTF8 -Value "<!doctype html><html><body style=`"margin:0;background:transparent`"><img src=`"$svgUri`" width=`"$Size`" height=`"$Size`" style=`"display:block`"></body></html>"
    $out = Join-Path $tmp 'icon.png'
    $cmd = "`"$browser`" --headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --user-data-dir=`"$tmp\profile`" --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 --window-size=$Size,$Size --screenshot=`"$out`" `"$(([Uri]$html).AbsoluteUri)`""
    # In this session, not through powershell.exe: a native command line would split $cmd at its quotes.
    & $launcher -WorkingDirectory $tmp -TimeoutSec 120 -CommandLine $cmd
    if (-not (Test-Path $out)) { throw "no screenshot from $browser" }
    Copy-Item $out $png -Force
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($png)
    try { "images/icon.png: $($img.Width)x$($img.Height)" } finally { $img.Dispose() }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
