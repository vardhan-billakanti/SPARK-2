import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const chrome1 = path.join(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe');
console.log('Chrome exists at:', chrome1, fs.existsSync(chrome1));

const url = 'https://www.youtube.com';
const cmdArgs = ['/c', 'start', '""', chrome1, url];
console.log('cmdArgs:', cmdArgs);

const child = spawn('cmd.exe', cmdArgs, {
  detached: true,
  stdio: 'pipe',
  windowsHide: true,
});

child.stdout.on('data', d => console.log('stdout:', d.toString()));
child.stderr.on('data', d => console.log('stderr:', d.toString()));
child.on('close', code => console.log('close code:', code));
