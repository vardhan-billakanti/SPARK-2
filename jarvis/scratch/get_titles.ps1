Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinFinder {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public static string[] GetVisibleTitles() {
        var list = new List<string>();
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                StringBuilder sbTitle = new StringBuilder(512);
                GetWindowText(hWnd, sbTitle, 512);
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string title = sbTitle.ToString().Trim();
                if (!string.IsNullOrEmpty(title)) {
                    list.Add(pid + " | " + title);
                }
            }
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
"@

$titles = [WinFinder]::GetVisibleTitles()
$titles | ForEach-Object { Write-Output $_ }
