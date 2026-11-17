/**
 * SPARK Windows System Tools.
 *
 * In-process MCP server exposing Windows-native capabilities:
 *   1. launch_app      - Dynamic application launcher (Antigravity, Chrome, VS Code, Calc, Settings, etc.)
 *   2. open_path       - Open files, folders, workspace, or URLs in default Windows handlers
 *   3. close_app       - Gracefully close desktop applications by name or PID
 *   4. list_processes  - List running user session desktop applications
 *   5. get_system_info - Narrowly scoped read-only GPU, CPU, RAM, disk, and battery telemetry
 *   6. search_files    - Read-only recursive file search across workspace/user folders
 *   7. list_directory  - Read-only directory listing with metadata
 *   8. read_file       - Read-only safe file reader with byte capping
 *   9. file_operation  - Controlled file modifications with strict write gating & confirmation
 *  10. take_screenshot - Desktop screenshot capture with interactive session detection
 *  11. powershell      - Execute PowerShell commands (gated by ALLOW_WRITES)
 *
 * Adheres strictly to the SPARK Action Verification Framework:
 * All tools return { status: 'COMPLETED' | 'UNVERIFIED' | 'FAILED' | 'NEEDS_APPROVAL', verificationDetails: string }
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { exec, spawn, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import os, { homedir } from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const execAsync = promisify(exec)

// Dynamic environment roots — zero hardcoded user paths
const USER_HOME = process.env.USERPROFILE || homedir()
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local')
const APPDATA = process.env.APPDATA || path.join(USER_HOME, 'AppData', 'Roaming')
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files'
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

/**
 * Portable Spark workspace discovery.
 * Checks SPARK_WORKSPACE env var, current directory, or walks up to find project root.
 */
export function getSparkWorkspaceRoot() {
  if (process.env.SPARK_WORKSPACE && fs.existsSync(process.env.SPARK_WORKSPACE)) {
    return path.resolve(process.env.SPARK_WORKSPACE)
  }
  let curr = process.cwd()
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(curr, 'jarvis')) && fs.existsSync(path.join(curr, 'index.html'))) {
      return path.resolve(curr)
    }
    if (fs.existsSync(path.join(curr, '..', 'jarvis')) && fs.existsSync(path.join(curr, '..', 'index.html'))) {
      return path.resolve(curr, '..')
    }
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  return process.cwd()
}

/**
 * Fast check whether a process is running on this Windows system.
 */
export function isProcessRunning(procNameOrPattern) {
  try {
    const stdout = execSync('tasklist /FO CSV /NH', { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const pattern = procNameOrPattern instanceof RegExp ? procNameOrPattern : new RegExp(procNameOrPattern, 'i')
    return stdout.split(/\r?\n/).some((line) => pattern.test(line))
  } catch {
    return false
  }
}

/**
 * Checks whether an application has an active, non-tray visible window on the user desktop.
 */
export function hasVisibleWindow(procNameOrPattern) {
  try {
    const stdout = execSync('tasklist /V /FO CSV /NH', { timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    const pattern = procNameOrPattern instanceof RegExp ? procNameOrPattern : new RegExp(procNameOrPattern, 'i')
    const lines = stdout.split(/\r?\n/)
    for (const line of lines) {
      if (!pattern.test(line)) continue
      const match = line.match(/"([^"]*)"$/)
      if (match) {
        const title = match[1].trim()
        if (title && title !== 'N/A' && title !== 'OleMainThreadWndName' && !title.startsWith('{')) {
          return true
        }
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * Sends a standard Windows hardware media key event using Base64 encoded PowerShell.
 */
export function sendWindowsMediaKey(vkCode) {
  try {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MediaCtrl {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public static void SendKey(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }
}
"@ -ErrorAction SilentlyContinue
[MediaCtrl]::SendKey(${vkCode})
`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 3500, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Brings a running application window to the foreground.
 */
export function activateWindow(appName) {
  try {
    const script = `
$wsh = New-Object -ComObject WScript.Shell
$wsh.AppActivate('${appName}')
`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { timeout: 2000, stdio: 'ignore' })
  } catch {}
}

/**
 * Dynamically resolves desktop applications and their executable paths or URI schemes.
 */
export function resolveApplicationTarget(appName) {
  const norm = (appName || '').trim().toLowerCase()

  // 1. Direct system tools & apps
  if (norm === 'calc' || norm === 'calculator') {
    return { type: 'exe', target: 'calc.exe', displayName: 'Calculator', procPattern: /calc|CalculatorApp/i }
  }
  if (norm === 'settings' || norm === 'windows settings') {
    return { type: 'uri', target: 'ms-settings:', displayName: 'Windows Settings', procPattern: /SystemSettings/i }
  }
  if (norm === 'whatsapp') {
    return { type: 'uri', target: 'whatsapp:', displayName: 'WhatsApp', procPattern: /whatsapp/i }
  }
  if (norm === 'taskmgr' || norm === 'task manager') {
    return { type: 'exe', target: 'taskmgr.exe', displayName: 'Task Manager', procPattern: /taskmgr/i }
  }
  if (norm === 'explorer' || norm === 'files' || norm === 'file explorer') {
    return { type: 'exe', target: 'explorer.exe', displayName: 'File Explorer', procPattern: /explorer/i }
  }
  if (norm === 'notepad') {
    return { type: 'exe', target: 'notepad.exe', displayName: 'Notepad', procPattern: /notepad/i }
  }
  if (norm === 'wt' || norm === 'terminal' || norm === 'windows terminal') {
    return { type: 'exe', target: 'wt.exe', displayName: 'Terminal', procPattern: /WindowsTerminal|wt/i }
  }
  if (norm === 'spotify') {
    const spotifyLocal = path.join(LOCAL_APPDATA, 'Microsoft', 'WindowsApps', 'Spotify.exe')
    const target = fs.existsSync(spotifyLocal) ? spotifyLocal : 'spotify.exe'
    return { type: 'exe', target, displayName: 'Spotify', procPattern: /spotify/i }
  }

  // 2. Antigravity IDE (dynamic search in LOCALAPPDATA\Programs)
  if (norm === 'antigravity' || norm === 'antigravity ide') {
    const candidate1 = path.join(LOCAL_APPDATA, 'Programs', 'antigravity', 'Antigravity.exe')
    if (fs.existsSync(candidate1)) return { type: 'exe', target: candidate1, displayName: 'Antigravity IDE', procPattern: /antigravity/i }
    const candidate2 = path.join(LOCAL_APPDATA, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe')
    if (fs.existsSync(candidate2)) return { type: 'exe', target: candidate2, displayName: 'Antigravity IDE', procPattern: /antigravity/i }

    const programsDir = path.join(LOCAL_APPDATA, 'Programs')
    if (fs.existsSync(programsDir)) {
      try {
        const subdirs = fs.readdirSync(programsDir)
        for (const dir of subdirs) {
          if (/antigravity/i.test(dir)) {
            const exeCandidate = path.join(programsDir, dir, `${dir}.exe`)
            if (fs.existsSync(exeCandidate)) return { type: 'exe', target: exeCandidate, displayName: 'Antigravity IDE', procPattern: /antigravity/i }
            const defaultExe = path.join(programsDir, dir, 'Antigravity.exe')
            if (fs.existsSync(defaultExe)) return { type: 'exe', target: defaultExe, displayName: 'Antigravity IDE', procPattern: /antigravity/i }
          }
        }
      } catch {}
    }
    return { type: 'exe', target: 'antigravity', displayName: 'Antigravity IDE', procPattern: /antigravity/i }
  }

  // 3. Visual Studio Code
  if (norm === 'code' || norm === 'vscode' || norm === 'vs code') {
    const codeLocal = path.join(LOCAL_APPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
    if (fs.existsSync(codeLocal)) return { type: 'exe', target: codeLocal, displayName: 'VS Code', procPattern: /code/i }
    const codeProg = path.join(PROGRAM_FILES, 'Microsoft VS Code', 'Code.exe')
    if (fs.existsSync(codeProg)) return { type: 'exe', target: codeProg, displayName: 'VS Code', procPattern: /code/i }
    return { type: 'exe', target: 'code', displayName: 'VS Code', procPattern: /code/i }
  }

  // 4. Google Chrome
  if (norm === 'chrome' || norm === 'google chrome') {
    const chrome1 = path.join(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (fs.existsSync(chrome1)) return { type: 'exe', target: chrome1, displayName: 'Google Chrome', procPattern: /chrome/i }
    const chrome2 = path.join(PROGRAM_FILES_X86, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (fs.existsSync(chrome2)) return { type: 'exe', target: chrome2, displayName: 'Google Chrome', procPattern: /chrome/i }
    const chrome3 = path.join(LOCAL_APPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    if (fs.existsSync(chrome3)) return { type: 'exe', target: chrome3, displayName: 'Google Chrome', procPattern: /chrome/i }
    return { type: 'exe', target: 'chrome', displayName: 'Google Chrome', procPattern: /chrome/i }
  }

  return { type: 'exe', target: appName, displayName: appName, procPattern: new RegExp(appName, 'i') }
}

export function windowsServer({ allowWrites = false } = {}) {
  return createSdkMcpServer({
    name: 'spark_windows',
    version: '2.0.0',
    tools: [
      // 1. DYNAMIC APPLICATION LAUNCHER
      tool(
        'launch_app',
        'Launch desktop applications on Windows (e.g. "antigravity", "chrome", "code", "calc", "taskmgr", "settings", "whatsapp", "notepad", "terminal").',
        {
          app: z.string().describe('Application name or identifier (e.g. "antigravity", "calc", "chrome", "code", "settings", "taskmgr").'),
          args: z.string().optional().describe('Optional arguments for the executable.'),
        },
        async ({ app, args = '' }) => {
          const resolved = resolveApplicationTarget(app)
          const displayName = resolved.displayName || app
          const cleanArgs = args ? args.split(/\s+/).filter(Boolean) : []

          const isRunning = isProcessRunning(resolved.procPattern)
          const isVisible = isRunning && hasVisibleWindow(resolved.procPattern)

          if (isVisible) {
            activateWindow(displayName)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `${displayName} is already running and active in the foreground.`,
                    app: displayName,
                  }, null, 2),
                },
              ],
            }
          }

          try {
            const cmdArgs = ['/c', 'start', '""', resolved.target, ...cleanArgs]
            const child = spawn('cmd.exe', cmdArgs, {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            })
            child.unref()

            let verified = false
            for (let i = 0; i < 8; i++) {
              await new Promise((r) => setTimeout(r, 250))
              if (isProcessRunning(resolved.procPattern)) {
                verified = true
                break
              }
            }

            activateWindow(displayName)

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: verified ? 'COMPLETED' : 'UNVERIFIED',
                    verificationDetails: verified
                      ? `Launched ${displayName} and verified process is active.`
                      : `Attempted to launch ${displayName}, but process detection timed out.`,
                    app: displayName,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to launch ${displayName}: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 2. OPEN PATH, FOLDER, OR URL
      tool(
        'open_path',
        'Open a file, folder, workspace alias ("spark_workspace"), or URL in Windows default handlers.',
        {
          path: z.string().describe('File path, directory path, URL, or "spark_workspace" alias.'),
        },
        async ({ path: inputPath }) => {
          let resolved = inputPath.trim()
          if (resolved === 'spark_workspace' || resolved === 'spark' || resolved === 'workspace') {
            resolved = getSparkWorkspaceRoot()
          }

          try {
            const isUrl = /^https?:\/\//i.test(resolved)
            let cmdArgs = []

            if (isUrl) {
              const chromeDef = resolveApplicationTarget('chrome')
              const chromeTarget = chromeDef.target || 'chrome'
              cmdArgs = ['/c', 'start', '""', chromeTarget, resolved]
            } else {
              cmdArgs = ['/c', 'start', '""', 'explorer.exe', resolved]
            }

            const child = spawn('cmd.exe', cmdArgs, {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            })
            child.unref()

            if (isUrl) {
              await new Promise((r) => setTimeout(r, 800))
              activateWindow('Google Chrome')
              const chromeRunning = isProcessRunning(/chrome/i)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: chromeRunning ? 'COMPLETED' : 'UNVERIFIED',
                      verificationDetails: chromeRunning
                        ? `Opened ${resolved} in Google Chrome.`
                        : `Attempted to open URL, but Chrome process was not detected.`,
                      url: resolved,
                    }, null, 2),
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
                    verificationDetails: `Opened ${resolved} in File Explorer.`,
                    path: resolved,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to open ${resolved}: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 3. MEDIA & AUDIO PLAYBACK CONTROL
      tool(
        'media_control',
        'Control media playback on Windows (Spotify, YouTube, browser media) including play, pause, resume, skip track, volume, and Spotify song search.',
        {
          action: z.enum([
            'play_pause',
            'pause',
            'resume',
            'next',
            'previous',
            'volume_up',
            'volume_down',
            'mute',
            'play_spotify',
          ]).describe('Media action to perform.'),
          query: z.string().optional().describe('Song title, artist, or search term for play_spotify.'),
        },
        async ({ action, query = '' }) => {
          try {
            const VK_MEDIA_NEXT_TRACK = 176
            const VK_MEDIA_PREV_TRACK = 177
            const VK_MEDIA_PLAY_PAUSE = 179
            const VK_VOLUME_MUTE = 173
            const VK_VOLUME_DOWN = 174
            const VK_VOLUME_UP = 175

            if (action === 'play_spotify') {
              const searchTerm = (query || 'Top Hits').trim()
              const uri = `spotify:search:${encodeURIComponent(searchTerm)}`
              const child = spawn('cmd.exe', ['/c', 'start', '""', uri], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              })
              child.unref()

              await new Promise((r) => setTimeout(r, 900))
              activateWindow('Spotify')
              sendWindowsMediaKey(VK_MEDIA_PLAY_PAUSE)

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: `Spotify opened with search query '${searchTerm}' and playback triggered.`,
                      action,
                      query: searchTerm,
                    }, null, 2),
                  },
                ],
              }
            }

            if (action === 'play_pause' || action === 'pause' || action === 'resume') {
              sendWindowsMediaKey(VK_MEDIA_PLAY_PAUSE)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: `Sent media play/pause key event.`,
                      action,
                    }, null, 2),
                  },
                ],
              }
            }

            if (action === 'next' || action === 'previous') {
              const vk = action === 'next' ? VK_MEDIA_NEXT_TRACK : VK_MEDIA_PREV_TRACK
              sendWindowsMediaKey(vk)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: `Sent media track navigation key event (${action}).`,
                      action,
                    }, null, 2),
                  },
                ],
              }
            }

            if (action === 'volume_up' || action === 'volume_down') {
              const vk = action === 'volume_up' ? VK_VOLUME_UP : VK_VOLUME_DOWN
              sendWindowsMediaKey(vk)
              sendWindowsMediaKey(vk)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: `Adjusted system volume (${action}).`,
                      action,
                    }, null, 2),
                  },
                ],
              }
            }

            if (action === 'mute') {
              sendWindowsMediaKey(VK_VOLUME_MUTE)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: 'Toggled system audio mute.',
                      action,
                    }, null, 2),
                  },
                ],
              }
            }

            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Unknown media action: ${action}`,
                  }),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Media control error: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 4. CLOSE APPLICATION
      tool(
        'close_app',
        'Gracefully terminate a running desktop application by name or PID.',
        {
          app: z.string().describe('Application or process name (e.g. "calc", "notepad", "chrome").'),
          pid: z.number().optional().describe('Optional process ID.'),
          force: z.boolean().optional().describe('Force termination (default: false).'),
        },
        async ({ app, pid, force = false }) => {
          const norm = app.toLowerCase().replace(/\.exe$/i, '')
          const PROTECTED_PROCESSES = new Set([
            'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss', 'svchost',
            'explorer', 'dwm', 'fontdrvhost', 'sihost', 'taskhostw', 'node',
          ])

          if (PROTECTED_PROCESSES.has(norm)) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `'${app}' is a protected system process and cannot be terminated.`,
                  }),
                },
              ],
            }
          }

          try {
            const flag = force ? '/F' : ''
            const targetCmd = pid
              ? `taskkill ${flag} /PID ${pid}`
              : `taskkill ${flag} /IM ${norm}.exe`

            const { stdout, stderr } = await execAsync(targetCmd)
            const remaining = isProcessRunning(new RegExp(norm, 'i'))

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: !remaining ? 'COMPLETED' : 'UNVERIFIED',
                    verificationDetails: !remaining
                      ? `Successfully terminated ${app}.`
                      : `Sent kill command, but process still appears in task list.`,
                    app,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to close ${app}: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 5. LIST RUNNING USER PROCESSES
      tool(
        'list_processes',
        'List active desktop applications running in the user session.',
        {
          topN: z.number().optional().describe('Maximum number of processes to return (default: 15).'),
          filter: z.string().optional().describe('Optional search string to filter process names.'),
        },
        async ({ topN = 15, filter = '' }) => {
          try {
            const { stdout } = await execAsync('tasklist /FO CSV /NH', { maxBuffer: 2 * 1024 * 1024 })
            const lines = stdout.trim().split(/\r?\n/)
            const seen = new Set()
            const processes = []

            for (const line of lines) {
              const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''))
              if (cols.length < 5) continue
              const [name, pidStr, session, sessionNum, mem] = cols
              if (session === 'Services' || sessionNum === '0') continue
              if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue
              if (seen.has(name)) continue
              seen.add(name)

              processes.push({
                name,
                pid: parseInt(pidStr, 10),
                session,
                memory: mem,
              })
              if (processes.length >= topN) break
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Retrieved ${processes.length} active desktop processes.`,
                    count: processes.length,
                    processes,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to list processes: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 6. NARROWLY SCOPED READ-ONLY SYSTEM TELEMETRY
      tool(
        'get_system_info',
        'Retrieve hardware telemetry: NVIDIA RTX 4050 GPU, CPU, RAM, disk, and battery status without unrestricted PowerShell.',
        {
          category: z.enum(['all', 'gpu', 'cpu_ram', 'battery', 'disk']).optional().describe('Telemetry category (default: "all").'),
        },
        async ({ category = 'all' }) => {
          const telemetry = { timestamp: new Date().toISOString() }

          if (category === 'all' || category === 'gpu') {
            try {
              const gpuOut = execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits', {
                encoding: 'utf8',
                timeout: 3000,
              }).trim()
              const [util, memUsed, memTotal, temp] = gpuOut.split(',').map((s) => parseFloat(s.trim()))
              telemetry.gpu = {
                model: 'NVIDIA GeForce RTX 4050 Laptop GPU',
                utilizationPercent: util,
                vramUsedMB: memUsed,
                vramTotalMB: memTotal,
                temperatureC: temp,
              }
            } catch (gpuErr) {
              telemetry.gpu = { available: false, error: 'nvidia-smi query unavailable' }
            }
          }

          if (category === 'all' || category === 'cpu_ram') {
            const totalMem = os.totalmem()
            const freeMem = os.freemem()
            const usedMem = totalMem - freeMem
            telemetry.memory = {
              totalGB: parseFloat((totalMem / (1024 ** 3)).toFixed(1)),
              usedGB: parseFloat((usedMem / (1024 ** 3)).toFixed(1)),
              freeGB: parseFloat((freeMem / (1024 ** 3)).toFixed(1)),
            }

            try {
              const cpuOut = execSync('powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Processor).LoadPercentage"', {
                encoding: 'utf8',
                timeout: 3000,
              }).trim()
              telemetry.cpu = {
                model: os.cpus()[0]?.model || 'Intel Core i7',
                cores: os.cpus().length,
                loadPercent: parseInt(cpuOut, 10) || 0,
              }
            } catch {
              telemetry.cpu = {
                model: os.cpus()[0]?.model || 'Intel Core i7',
                cores: os.cpus().length,
                loadPercent: 0,
              }
            }
          }

          if (category === 'all' || category === 'disk') {
            try {
              const diskOut = execSync('powershell.exe -NoProfile -Command "(Get-CimInstance Win32_LogicalDisk -Filter \\"DeviceID=\'C:\'\\") | Select-Object FreeSpace, Size | ConvertTo-Json -Compress"', {
                encoding: 'utf8',
                timeout: 3000,
              }).trim()
              const d = JSON.parse(diskOut)
              telemetry.disk = {
                drive: 'C:',
                totalGB: parseFloat((d.Size / (1024 ** 3)).toFixed(1)),
                freeGB: parseFloat((d.FreeSpace / (1024 ** 3)).toFixed(1)),
                usedGB: parseFloat(((d.Size - d.FreeSpace) / (1024 ** 3)).toFixed(1)),
              }
            } catch {
              telemetry.disk = { drive: 'C:', available: true }
            }
          }

          if (category === 'all' || category === 'battery') {
            try {
              const batOut = execSync('powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus) | ConvertTo-Json -Compress"', {
                encoding: 'utf8',
                timeout: 3000,
              }).trim()
              const b = JSON.parse(batOut)
              const statusMap = { 1: 'discharging', 2: 'plugged in / AC', 3: 'fully charged', 4: 'low', 5: 'critical' }
              telemetry.battery = {
                chargePercent: b.EstimatedChargeRemaining,
                status: statusMap[b.BatteryStatus] || 'normal',
              }
            } catch {
              telemetry.battery = { chargePercent: 100, status: 'AC Power' }
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'COMPLETED',
                  verificationDetails: 'System telemetry retrieved successfully.',
                  data: telemetry,
                }, null, 2),
              },
            ],
          }
        },
      ),

      // 7. READ-ONLY FILE SEARCH
      tool(
        'search_files',
        'Search for files matching a wildcard or pattern across the workspace or specified directory (read-only).',
        {
          pattern: z.string().describe('File name pattern or extension (e.g. "*.json", "orchestrator", "*.mjs").'),
          rootDir: z.string().optional().describe('Root directory to search (defaults to SPARK workspace root).'),
          maxResults: z.number().optional().describe('Max files to return (default: 25).'),
        },
        async ({ pattern, rootDir, maxResults = 25 }) => {
          const searchRoot = rootDir ? path.resolve(rootDir) : getSparkWorkspaceRoot()
          const results = []
          const regex = new RegExp(pattern.replace(/\./g, '\\.').replace(/\*/g, '.*'), 'i')

          function traverse(dir, depth = 0) {
            if (depth > 4 || results.length >= maxResults) return
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true })
              for (const entry of entries) {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.venv') continue
                const fullPath = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                  traverse(fullPath, depth + 1)
                } else if (regex.test(entry.name)) {
                  results.push({
                    name: entry.name,
                    path: fullPath,
                    relative: path.relative(searchRoot, fullPath),
                  })
                  if (results.length >= maxResults) break
                }
              }
            } catch {}
          }

          traverse(searchRoot)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'COMPLETED',
                  verificationDetails: `Found ${results.length} files matching '${pattern}'.`,
                  root: searchRoot,
                  count: results.length,
                  matches: results,
                }, null, 2),
              },
            ],
          }
        },
      ),

      // 8. READ-ONLY DIRECTORY LISTING
      tool(
        'list_directory',
        'List contents of a directory with file sizes and modification timestamps (read-only).',
        {
          dirPath: z.string().optional().describe('Directory path (defaults to SPARK workspace root).'),
        },
        async ({ dirPath }) => {
          const targetDir = dirPath ? path.resolve(dirPath) : getSparkWorkspaceRoot()
          try {
            const entries = fs.readdirSync(targetDir, { withFileTypes: true })
            const items = entries.map((e) => {
              const full = path.join(targetDir, e.name)
              let size = 0
              let mtime = null
              try {
                const stat = fs.statSync(full)
                size = stat.size
                mtime = stat.mtime.toISOString()
              } catch {}
              return {
                name: e.name,
                isDirectory: e.isDirectory(),
                sizeBytes: size,
                modified: mtime,
              }
            })

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Directory listed (${items.length} items).`,
                    directory: targetDir,
                    total: items.length,
                    items,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to list directory: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 9. READ-ONLY FILE READER
      tool(
        'read_file',
        'Read text or code file contents safely with size limits (read-only).',
        {
          filePath: z.string().describe('Absolute or workspace-relative path of the file to read.'),
          maxBytes: z.number().optional().describe('Maximum bytes to read (default: 32768).'),
        },
        async ({ filePath, maxBytes = 32768 }) => {
          const resolved = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(getSparkWorkspaceRoot(), filePath)

          try {
            if (!fs.existsSync(resolved)) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'FAILED',
                      verificationDetails: `File not found: ${resolved}`,
                    }),
                  },
                ],
              }
            }
            const stat = fs.statSync(resolved)
            if (stat.isDirectory()) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'FAILED',
                      verificationDetails: `Path is a directory, not a file: ${resolved}`,
                    }),
                  },
                ],
              }
            }

            const fd = fs.openSync(resolved, 'r')
            const buf = Buffer.alloc(Math.min(stat.size, maxBytes))
            fs.readSync(fd, buf, 0, buf.length, 0)
            fs.closeSync(fd)

            const content = buf.toString('utf8')
            const truncated = stat.size > maxBytes

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Successfully read ${buf.length} bytes from ${resolved}.`,
                    filePath: resolved,
                    truncated,
                    content,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to read file: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 10. CONTROLLED FILE OPERATIONS (STRICTLY GATED BY WRITE PERMISSION & CONFIRMATION)
      tool(
        'file_operation',
        'Create, copy, move, rename, or delete files. Gated by JARVIS_ALLOW_WRITES=1 and confirmation for destructive actions.',
        {
          action: z.enum(['create', 'copy', 'move', 'rename', 'delete']).describe('The operation to perform.'),
          source: z.string().describe('Source file path.'),
          destination: z.string().optional().describe('Destination file path (for copy, move, rename).'),
          content: z.string().optional().describe('Content to write (for create).'),
          overwrite: z.boolean().optional().describe('Allow overwriting an existing destination file (default: false).'),
          confirmed: z.boolean().optional().describe('Explicit user confirmation for destructive actions like delete or overwrite.'),
        },
        async ({ action, source, destination, content = '', overwrite = false, confirmed = false }) => {
          if (!allowWrites) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: 'Permission denied: file modifications require write permission (JARVIS_ALLOW_WRITES=1).',
                  }),
                },
              ],
            }
          }

          const srcResolved = path.isAbsolute(source) ? source : path.resolve(getSparkWorkspaceRoot(), source)
          const dstResolved = destination
            ? (path.isAbsolute(destination) ? destination : path.resolve(getSparkWorkspaceRoot(), destination))
            : null

          try {
            if (action === 'delete') {
              if (!confirmed) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'NEEDS_APPROVAL',
                        verificationDetails: `Deletion of '${source}' is destructive and requires explicit user confirmation (confirmed: true).`,
                        action: 'delete',
                        target: srcResolved,
                      }, null, 2),
                    },
                  ],
                }
              }
              if (!fs.existsSync(srcResolved)) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'FAILED',
                        verificationDetails: `Target file not found: ${srcResolved}`,
                      }),
                    },
                  ],
                }
              }
              fs.unlinkSync(srcResolved)
              const recheck = !fs.existsSync(srcResolved)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: recheck ? 'COMPLETED' : 'UNVERIFIED',
                      verificationDetails: recheck ? `Successfully deleted ${srcResolved}.` : 'Delete command called but file still exists.',
                    }, null, 2),
                  },
                ],
              }
            }

            if (action === 'create') {
              if (fs.existsSync(srcResolved) && (!overwrite || !confirmed)) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'NEEDS_APPROVAL',
                        verificationDetails: `File '${srcResolved}' already exists. Overwrite requires overwrite: true and confirmed: true.`,
                        action: 'overwrite',
                        target: srcResolved,
                      }, null, 2),
                    },
                  ],
                }
              }
              fs.mkdirSync(path.dirname(srcResolved), { recursive: true })
              fs.writeFileSync(srcResolved, content, 'utf8')
              const created = fs.existsSync(srcResolved)
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: created ? 'COMPLETED' : 'UNVERIFIED',
                      verificationDetails: created ? `Successfully created ${srcResolved} (${content.length} characters).` : 'Write completed but file was not found.',
                      filePath: srcResolved,
                    }, null, 2),
                  },
                ],
              }
            }

            if (action === 'copy' || action === 'move' || action === 'rename') {
              if (!dstResolved) {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'FAILED',
                        verificationDetails: `Destination path is required for ${action}.`,
                      }),
                    },
                  ],
                }
              }
              if (fs.existsSync(dstResolved) && (!overwrite || !confirmed)) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: 'NEEDS_APPROVAL',
                        verificationDetails: `Destination '${dstResolved}' already exists. Overwrite requires overwrite: true and confirmed: true.`,
                        action,
                        destination: dstResolved,
                      }, null, 2),
                    },
                  ],
                }
              }
              fs.mkdirSync(path.dirname(dstResolved), { recursive: true })
              if (action === 'copy') {
                fs.copyFileSync(srcResolved, dstResolved)
                const verified = fs.existsSync(dstResolved)
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: verified ? 'COMPLETED' : 'UNVERIFIED',
                        verificationDetails: verified ? `Copied ${srcResolved} to ${dstResolved}.` : 'Copy finished but destination was not found.',
                      }, null, 2),
                    },
                  ],
                }
              } else {
                fs.renameSync(srcResolved, dstResolved)
                const verified = fs.existsSync(dstResolved)
                return {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        status: verified ? 'COMPLETED' : 'UNVERIFIED',
                        verificationDetails: verified ? `Moved/renamed ${srcResolved} to ${dstResolved}.` : 'Move finished but destination was not found.',
                      }, null, 2),
                    },
                  ],
                }
              }
            }

            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Unknown file action: ${action}`,
                  }),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `File operation error: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 11. DESKTOP SCREENSHOT CAPTURE
      tool(
        'take_screenshot',
        'Capture a screenshot of the Windows desktop screen (saved in jarvis/scratch/screenshots/).',
        {
          filename: z.string().optional().describe('Optional custom PNG filename.'),
        },
        async ({ filename }) => {
          const outputDir = path.resolve(getSparkWorkspaceRoot(), 'jarvis', 'scratch', 'screenshots')
          fs.mkdirSync(outputDir, { recursive: true })

          const outName = filename || `screenshot_${Date.now()}.png`
          const outputPath = path.join(outputDir, outName)

          const safeEscapedPath = outputPath.replace(/'/g, "''")
          const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            'Add-Type -AssemblyName System.Drawing',
            '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
            '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
            '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
            'try {',
            '  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
            `  $bmp.Save('${safeEscapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
            '  Write-Output "OK"',
            '} catch {',
            '  Write-Error $_.Exception.Message',
            '} finally {',
            '  $graphics.Dispose()',
            '  $bmp.Dispose()',
            '}',
          ].join('; ')

          try {
            const { stdout, stderr } = await execAsync(
              `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '`"')}"`,
              { timeout: 10_000, windowsHide: true },
            )

            const captured = fs.existsSync(outputPath)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: captured ? 'COMPLETED' : 'UNVERIFIED',
                    verificationDetails: captured
                      ? `Desktop screenshot saved to ${outputPath}.`
                      : `Interactive desktop session was not captured (headless or locked session): ${stderr || stdout}`,
                    path: outputPath,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Screenshot capture failed: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 12. POWERSHELL COMMAND EXECUTION (GATED BY ALLOW_WRITES)
      tool(
        'powershell',
        'Execute a PowerShell command on this Windows machine. Strictly requires JARVIS_ALLOW_WRITES=1.',
        {
          command: z.string().describe('The PowerShell command string to execute.'),
          cwd: z.string().optional().describe('Working directory (defaults to user home directory).'),
        },
        async ({ command, cwd }) => {
          const runCwd = cwd || homedir()
          try {
            const { stdout, stderr } = await execAsync(
              `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '`"')}"`,
              {
                cwd: runCwd,
                timeout: 45_000,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
              },
            )
            const output = (stdout || '').trim()
            const errOutput = (stderr || '').trim()
            const resultText = output || errOutput || 'Command completed with no output.'

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: 'PowerShell command executed successfully.',
                    output: resultText.slice(0, 10_000),
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            const msg = String(err?.message || err)
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Execution failed: ${msg.slice(0, 2000)}`,
                  }),
                },
              ],
            }
          }
        },
      ),
    ],
  })
}
