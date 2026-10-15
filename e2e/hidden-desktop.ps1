# Runs a command on a separate, never-shown Win32 desktop, so GUI windows it opens (the e2e VS Code
# host) never appear on the user's screen and cannot steal focus. Child processes inherit the desktop.
# Usage:
#   pwsh -File hidden-desktop.ps1 -CommandLine 'cmd.exe /c "node e2e\run-e2e.mjs > e2e.log 2>&1"' -WorkingDirectory <dir>
#   pwsh -File hidden-desktop.ps1 -SelfTest      # windowless proof that the child really lands on that desktop
param(
    [string]$CommandLine,
    [string]$WorkingDirectory = (Get-Location).Path,
    [string]$DesktopName = 'csm-hidden-e2e',
    [int]$TimeoutSec = 1800,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HiddenDesktop {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetThreadDesktop(int threadId);
    [DllImport("kernel32.dll")]
    static extern int GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, int length, out int needed);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    const uint GENERIC_ALL = 0x10000000;
    const uint CREATE_NO_WINDOW = 0x08000000;

    public static string CurrentDesktopName() {
        var sb = new StringBuilder(256); int needed;
        GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), 2, sb, sb.Capacity * 2, out needed);
        return sb.ToString();
    }

    // Returns the exit code, -1 on timeout (the caller kills the tree by pid, written to pidOut[0]).
    public static int Run(string desktopName, string commandLine, string cwd, int timeoutMs, int[] pidOut) {
        IntPtr desktop = CreateDesktopW(desktopName, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
        try {
            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.lpDesktop = desktopName;
            PROCESS_INFORMATION pi;
            if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
                throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
            pidOut[0] = pi.dwProcessId;
            try {
                if (WaitForSingleObject(pi.hProcess, (uint)timeoutMs) != 0) return -1;
                uint code; GetExitCodeProcess(pi.hProcess, out code);
                return (int)code;
            } finally {
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
            }
        } finally {
            CloseDesktop(desktop);
        }
    }
}
'@
Add-Type -TypeDefinition $source

function Invoke-Hidden([string]$cmd, [string]$cwd, [int]$timeoutSec) {
    $pid0 = [int[]]::new(1)
    $code = [HiddenDesktop]::Run($DesktopName, $cmd, $cwd, $timeoutSec * 1000, $pid0)
    if ($code -eq -1) {
        # Timeout: kill the whole tree (node, the VS Code host and its helpers) so nothing lingers.
        & taskkill.exe /T /F /PID $pid0[0] | Out-Null
        Write-Output "TIMEOUT after $timeoutSec s, process tree killed"
        return 124
    }
    return $code
}

if ($SelfTest) {
    $probe = Join-Path ([IO.Path]::GetTempPath()) "hidden-desktop-probe-$PID.txt"
    $cs = Join-Path ([IO.Path]::GetTempPath()) "hidden-desktop-$PID.cs"
    Remove-Item $probe -ErrorAction SilentlyContinue
    Set-Content -Path $cs -Value $source
    $pwsh = (Get-Process -Id $PID).Path
    # The probe child loads the same type and writes the name of the desktop it actually runs on.
    $cmd = "`"$pwsh`" -NoProfile -NonInteractive -Command `"Add-Type -Path '$cs'; [HiddenDesktop]::CurrentDesktopName() | Set-Content '$probe'`""
    $null = Invoke-Hidden $cmd ([IO.Path]::GetTempPath()) 60
    $got = if (Test-Path $probe) { (Get-Content $probe -Raw).Trim() } else { '<no probe file>' }
    Remove-Item $probe, $cs -ErrorAction SilentlyContinue
    "parent desktop: $([HiddenDesktop]::CurrentDesktopName())"
    "child desktop:  $got"
    if ($got -eq $DesktopName) { 'SELFTEST OK'; exit 0 } else { 'SELFTEST FAILED'; exit 1 }
}

if (-not $CommandLine) { throw 'Pass -CommandLine or -SelfTest' }
exit (Invoke-Hidden $CommandLine $WorkingDirectory $TimeoutSec)
