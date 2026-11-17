import { execSync, spawn } from 'node:child_process';

console.log('Testing launch of Calculator...');
// Method 1: Start-Process calc.exe
try {
  execSync('powershell -NoProfile -Command "Start-Process calc.exe"');
  console.log('Start-Process calc.exe executed.');
} catch (e) {
  console.error('Method 1 error:', e.message);
}

// Wait 1 second
await new Promise((r) => setTimeout(r, 1000));

// Check processes via tasklist
const list = execSync('tasklist /FO CSV /NH').toString();
const matching = list.split(/\r?\n/).filter(line => /calc/i.test(line));
console.log('Matching processes:', matching);
