# Watches for native dialogs (#32770, the class of VS Code's "Do you want to
# save the changes?" message box with window.dialogStyle = native) owned by a
# process started from -ExePath whose parent is -OwnerParentPid (the e2e
# runner: its VS Code main process shows the dialogs). Another VS Code started
# from the same Code.exe, say with the user's own profile, is never touched.
# EnumWindows only sees the desktop this watcher runs on, too.
# Every new dialog is appended to -LogFile as one JSON line
# {t, title, buttons, clicked}, then dismissed with -Click (else Cancel, else
# its first button) so the e2e run fails instead of hanging.
# Prints "ready" once the watcher is compiled and polling.
param([string]$ExePath, [string]$LogFile, [int]$OwnerParentPid, [string]$Click = "Don't Save", [int]$IntervalMs = 50)
if (-not $OwnerParentPid) { throw 'Pass -OwnerParentPid (the process that started the VS Code under test)' }

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DialogWatch {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder s, ref uint n);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  static long ParentPid(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return -1;
    try {
      var pbi = new PBI(); int ret;
      return NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out ret) == 0 ? pbi.InheritedFromUniqueProcessId.ToInt64() : -1;
    } finally { CloseHandle(h); }
  }
  static string Cls(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }
  static string Txt(IntPtr h) { var t = new StringBuilder(1024); GetWindowText(h, t, 1024); return t.ToString(); }
  static Dictionary<uint, string> paths = new Dictionary<uint, string>();
  static string ImagePath(uint pid) {
    string p;
    if (paths.TryGetValue(pid, out p)) return p;
    p = "";
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h != IntPtr.Zero) {
      var sb = new StringBuilder(1024); uint n = 1024;
      if (QueryFullProcessImageName(h, 0, sb, ref n)) p = sb.ToString();
      CloseHandle(h);
    }
    paths[pid] = p;
    return p;
  }
  public class Found { public long Hwnd; public string Title; public List<string> Buttons = new List<string>(); public List<IntPtr> Handles = new List<IntPtr>(); }
  public static List<Found> Scan(string exe, long ownerParent) {
    var list = new List<Found>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || Cls(h) != "#32770") return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!string.Equals(ImagePath(pid), exe, StringComparison.OrdinalIgnoreCase)) return true;
      if (ParentPid(pid) != ownerParent) return true; // not the VS Code this e2e run started
      var f = new Found { Hwnd = h.ToInt64(), Title = Txt(h) };
      EnumChildWindows(h, (b, l2) => {
        if (Cls(b) == "Button") { f.Buttons.Add(Txt(b).Replace("&", "")); f.Handles.Add(b); }
        return true;
      }, IntPtr.Zero);
      list.Add(f);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string Press(Found f, string[] wanted) {
    foreach (var w in wanted) {
      for (int i = 0; i < f.Buttons.Count; i++) {
        if (string.Equals(f.Buttons[i].Trim(), w, StringComparison.OrdinalIgnoreCase)) {
          SendMessage(new IntPtr(f.Hwnd), 0x0006, (IntPtr)1, IntPtr.Zero); // WM_ACTIVATE
          PostMessage(f.Handles[i], 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
          return f.Buttons[i];
        }
      }
    }
    if (f.Handles.Count > 0) { PostMessage(f.Handles[0], 0x00F5, IntPtr.Zero, IntPtr.Zero); return f.Buttons[0]; }
    return "";
  }
}
"@

$exe = [System.IO.Path]::GetFullPath($ExePath)
$handled = @{}
Write-Output "ready"
[Console]::Out.Flush()
while ($true) {
  foreach ($f in [DialogWatch]::Scan($exe, $OwnerParentPid)) {
    if ($handled.ContainsKey($f.Hwnd)) { continue }
    $handled[$f.Hwnd] = $true
    Start-Sleep -Milliseconds 300 # let the dialog finish laying out its buttons
    $f = [DialogWatch]::Scan($exe, $OwnerParentPid) | Where-Object { $_.Hwnd -eq $f.Hwnd } | Select-Object -First 1
    if (-not $f) { continue }
    $clicked = [DialogWatch]::Press($f, @($Click, "Cancel"))
    $line = [ordered]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); title = $f.Title; buttons = @($f.Buttons); clicked = $clicked } | ConvertTo-Json -Compress
    [System.IO.File]::AppendAllText($LogFile, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "dialog: $line"
  }
  Start-Sleep -Milliseconds $IntervalMs
}
