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

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public struct WindowInfo {
        public IntPtr Handle;
        public uint ProcessId;
        public string Title;
        public string ClassName;
    }

    public static List<WindowInfo> GetWindows() {
        var list = new List<WindowInfo>();
        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                StringBuilder sbTitle = new StringBuilder(256);
                GetWindowText(hWnd, sbTitle, 256);
                StringBuilder sbClass = new StringBuilder(256);
                GetClassName(hWnd, sbClass, 256);
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string title = sbTitle.ToString();
                if (!string.IsNullOrEmpty(title)) {
                    list.Add(new WindowInfo { Handle = hWnd, ProcessId = pid, Title = title, ClassName = sbClass.ToString() });
                }
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

$windows = [Win32]::GetWindows()
$windows | Where-Object { $_.Title -match 'Spotify' -or $_.ClassName -match 'Chrome_WidgetWin' } | Format-Table -AutoSize
