/**
 * SPARK Desktop Computer Control Engine.
 *
 * Implements mouse movement, clicks, keyboard typing, and hotkeys using
 * native Windows Forms and Win32 User32 API via Base64-encoded PowerShell.
 * Zero external Python or C++ dependencies required.
 *
 * Adheres strictly to the SPARK Action Verification Framework:
 * All tools return { status: 'COMPLETED' | 'UNVERIFIED' | 'FAILED' | 'NEEDS_APPROVAL', verificationDetails: string }
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execSync } from 'node:child_process'

function runPowerShellScript(script, timeoutMs = 4000) {
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const out = execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return { ok: true, stdout: out.toString().trim() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function controlServer({ allowWrites = true } = {}) {
  return createSdkMcpServer({
    name: 'spark_control',
    version: '1.0.0',
    tools: [
      // 1. MOVE MOUSE
      tool(
        'move_mouse',
        'Move the desktop mouse cursor to target screen coordinates (x, y).',
        {
          x: z.number().describe('Target horizontal screen coordinate in pixels.'),
          y: z.number().describe('Target vertical screen coordinate in pixels.'),
        },
        async ({ x, y }) => {
          const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})
$pos = [System.Windows.Forms.Cursor]::Position
Write-Output "$($pos.X),$($pos.Y)"
`
          const res = runPowerShellScript(script)
          if (!res.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to move mouse cursor: ${res.error}`,
                  }),
                },
              ],
            }
          }

          const [curX, curY] = res.stdout.split(',').map((s) => parseInt(s.trim(), 10))
          const verified = Math.abs(curX - x) <= 5 && Math.abs(curY - y) <= 5

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: verified ? 'COMPLETED' : 'UNVERIFIED',
                  verificationDetails: verified
                    ? `Mouse cursor moved to (${curX}, ${curY}).`
                    : `Command executed, cursor is at (${curX}, ${curY}) instead of target (${x}, ${y}).`,
                  coordinates: { x: curX, y: curY },
                }, null, 2),
              },
            ],
          }
        },
      ),

      // 2. CLICK MOUSE
      tool(
        'click_mouse',
        'Click the mouse at current or specified screen coordinates (left, right, or double click).',
        {
          button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to click (default: left).'),
          x: z.number().optional().describe('Optional horizontal coordinate to click.'),
          y: z.number().optional().describe('Optional vertical coordinate to click.'),
          doubleClick: z.boolean().optional().describe('Whether to perform a double-click (default: false).'),
        },
        async ({ button = 'left', x, y, doubleClick = false }) => {
          const moveBlock = (x !== undefined && y !== undefined)
            ? `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)}); Start-Sleep -Milliseconds 50`
            : ''

          const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseActions {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP   = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP   = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;

    public static void Click(string btn, bool dbl) {
        uint down = MOUSEEVENTF_LEFTDOWN;
        uint up   = MOUSEEVENTF_LEFTUP;
        if (btn == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (btn == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }

        mouse_event(down, 0, 0, 0, UIntPtr.Zero);
        mouse_event(up, 0, 0, 0, UIntPtr.Zero);
        if (dbl) {
            System.Threading.Thread.Sleep(100);
            mouse_event(down, 0, 0, 0, UIntPtr.Zero);
            mouse_event(up, 0, 0, 0, UIntPtr.Zero);
        }
    }
}
"@ -ErrorAction SilentlyContinue
${moveBlock}
[MouseActions]::Click("${button}", ${doubleClick ? '$true' : '$false'})
$pos = [System.Windows.Forms.Cursor]::Position
Write-Output "$($pos.X),$($pos.Y)"
`
          const res = runPowerShellScript(script)
          if (!res.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Mouse click failed: ${res.error}`,
                  }),
                },
              ],
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'COMPLETED',
                  verificationDetails: `Performed ${doubleClick ? 'double' : 'single'} ${button}-click at ${res.stdout}.`,
                  button,
                  doubleClick,
                  position: res.stdout,
                }, null, 2),
              },
            ],
          }
        },
      ),

      // 3. TYPE TEXT
      tool(
        'type_text',
        'Type text into the currently active desktop window or input element.',
        {
          text: z.string().describe('The string of text to type.'),
          pressEnter: z.boolean().optional().describe('Whether to press Enter after typing (default: false).'),
        },
        async ({ text, pressEnter = false }) => {
          // Escape SendKeys special characters: +, ^, %, ~, (, ), {, }, [, ]
          const sanitized = text
            .replace(/([+^%~{}()\[\]])/g, '{$1}')
            .replace(/"/g, '`"')

          const enterSnippet = pressEnter ? '; [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")' : ''

          const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${sanitized}")${enterSnippet}
Write-Output "OK"
`
          const res = runPowerShellScript(script)
          if (!res.ok) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to type text: ${res.error}`,
                  }),
                },
              ],
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'COMPLETED',
                  verificationDetails: `Successfully typed ${text.length} characters into active window.`,
                  textLength: text.length,
                  pressedEnter: pressEnter,
                }, null, 2),
              },
            ],
          }
        },
      ),

      // 4. PRESS HOTKEY
      tool(
        'press_hotkey',
        'Send a keyboard shortcut or key combination (e.g. "ctrl+c", "ctrl+v", "alt+tab", "enter", "escape", "win+d").',
        {
          keys: z.string().describe('Shortcut string, e.g. "ctrl+c", "ctrl+v", "ctrl+a", "alt+f4", "enter", "tab", "esc", "win+d", "win+r".'),
        },
        async ({ keys }) => {
          const norm = keys.trim().toLowerCase()

          // Map friendly shortcut names to SendKeys or WScript.Shell
          const sendKeysMap = {
            'ctrl+c': '^c',
            'ctrl+v': '^v',
            'ctrl+x': '^x',
            'ctrl+a': '^a',
            'ctrl+z': '^z',
            'ctrl+y': '^y',
            'ctrl+s': '^s',
            'ctrl+f': '^f',
            'ctrl+w': '^w',
            'ctrl+t': '^t',
            'alt+f4': '%{F4}',
            'alt+tab': '%{TAB}',
            'enter': '{ENTER}',
            'return': '{ENTER}',
            'esc': '{ESC}',
            'escape': '{ESC}',
            'tab': '{TAB}',
            'backspace': '{BACKSPACE}',
            'delete': '{DELETE}',
            'space': ' ',
            'up': '{UP}',
            'down': '{DOWN}',
            'left': '{LEFT}',
            'right': '{RIGHT}',
          }

          if (norm === 'win+d') {
            const script = `
$shell = New-Object -ComObject Shell.Application
$shell.ToggleDesktop()
Write-Output "OK"
`
            const res = runPowerShellScript(script)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: res.ok ? 'COMPLETED' : 'FAILED',
                    verificationDetails: res.ok ? 'Toggled Windows Desktop (Win+D).' : res.error,
                  }, null, 2),
                },
              ],
            }
          }

          if (norm === 'win+r') {
            const script = `
$shell = New-Object -ComObject Shell.Application
$shell.FileRun()
Write-Output "OK"
`
            const res = runPowerShellScript(script)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: res.ok ? 'COMPLETED' : 'FAILED',
                    verificationDetails: res.ok ? 'Opened Windows Run dialog (Win+R).' : res.error,
                  }, null, 2),
                },
              ],
            }
          }

          const sendKeySeq = sendKeysMap[norm] || keys
          const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${sendKeySeq}")
Write-Output "OK"
`
          const res = runPowerShellScript(script)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: res.ok ? 'COMPLETED' : 'FAILED',
                  verificationDetails: res.ok ? `Sent shortcut key combination '${keys}'.` : res.error,
                  keys,
                }, null, 2),
              },
            ],
          }
        },
      ),
    ],
  })
}
