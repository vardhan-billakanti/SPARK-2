Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public static void PrintWindows() {
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                StringBuilder sbTitle = new StringBuilder(256);
                GetWindowText(hWnd, sbTitle, 256);
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string title = sbTitle.ToString();
                if (!string.IsNullOrWhiteSpace(title)) {
                    Console.WriteLine(pid + ": " + title);
                }
            }
            return true;
        }, IntPtr.Zero);
    }
}
"@

[Win32]::PrintWindows()
