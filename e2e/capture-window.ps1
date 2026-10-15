# Saves a PNG of the largest visible top-level window owned by any process
# started from -ExePath (PrintWindow with PW_RENDERFULLCONTENT, so it works
# while other windows cover it, and on the hidden desktop of hidden-desktop.ps1,
# where this script must run too: EnumWindows only sees its own desktop).
# -Width/-Height first move that window to (0, 0) with that outer size (physical
# pixels); -ResizeOnly stops there without a capture. -CropTop leaves out that
# many pixels at the top (the title bar).
param([string]$ExePath, [string]$OutFile, [int]$Width = 0, [int]$Height = 0, [switch]$ResizeOnly, [int]$CropTop = 0)

Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class WinShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  public struct RECT { public int L, T, R, B; }
  static IntPtr Largest(uint[] pids) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (Array.IndexOf(pids, p) >= 0 && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        int a = (r.R - r.L) * (r.B - r.T);
        if (a > bestArea) { bestArea = a; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static string Resize(uint[] pids, int w, int h) {
    IntPtr win = Largest(pids);
    if (win == IntPtr.Zero) return "no window";
    ShowWindow(win, 9); // SW_RESTORE: a maximized window ignores MoveWindow
    MoveWindow(win, 0, 0, w, h, true);
    RECT rc; GetWindowRect(win, out rc);
    return "resized " + (rc.R - rc.L) + "x" + (rc.B - rc.T);
  }
  public static string Capture(uint[] pids, string file, int cropTop) {
    IntPtr best = Largest(pids);
    if (best == IntPtr.Zero) return "no window";
    RECT rc; GetWindowRect(best, out rc);
    int w = rc.R - rc.L, h = rc.B - rc.T;
    cropTop = Math.Max(0, Math.Min(cropTop, h - 1));
    using (var bmp = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        PrintWindow(best, hdc, 2);
        g.ReleaseHdc(hdc);
      }
      using (var cut = bmp.Clone(new Rectangle(0, cropTop, w, h - cropTop), bmp.PixelFormat)) {
        cut.Save(file, ImageFormat.Png);
      }
    }
    return "ok " + w + "x" + (h - cropTop);
  }
}
"@
$pids = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ExePath } | ForEach-Object { [uint32]$_.Id })
if ($Width -gt 0 -and $Height -gt 0) {
    [WinShot]::Resize([uint32[]]$pids, $Width, $Height)
    if ($ResizeOnly) { return }
    Start-Sleep -Milliseconds 800
}
[WinShot]::Capture([uint32[]]$pids, $OutFile, $CropTop)
