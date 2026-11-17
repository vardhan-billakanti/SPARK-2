import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const USER_HOME = process.env.USERPROFILE;
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local');
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';

const apps = [
  { name: 'Calculator', exe: 'calc.exe', procPattern: /calc|CalculatorApp/i },
  { name: 'Chrome', exe: 'chrome.exe', procPattern: /chrome/i },
  { name: 'Spotify', exe: 'spotify.exe', procPattern: /spotify/i },
  { name: 'Antigravity', exe: path.join(LOCAL_APPDATA, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'), procPattern: /antigravity/i },
  { name: 'File Explorer', exe: 'explorer.exe', procPattern: /explorer/i },
  { name: 'Windows Settings', uri: 'ms-settings:', procPattern: /SystemSettings/i },
  { name: 'Task Manager', exe: 'taskmgr.exe', procPattern: /taskmgr/i },
];

console.log('Testing App Resolution and Current Process Status:');
const tasklist = execSync('tasklist /FO CSV /NH').toString();

for (const a of apps) {
  const isRunning = tasklist.split(/\r?\n/).some(line => a.procPattern.test(line));
  let resolvedPath = a.exe || a.uri;
  let exists = false;
  if (a.exe && path.isAbsolute(a.exe)) {
    exists = fs.existsSync(a.exe);
  } else if (a.exe) {
    exists = true; // system PATH
  } else {
    exists = true; // URI scheme
  }
  console.log(`- ${a.name}: resolved="${resolvedPath}", exists=${exists}, currentlyRunning=${isRunning}`);
}
