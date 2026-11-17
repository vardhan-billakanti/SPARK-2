import { spawn, exec } from 'node:child_process';

console.log('Testing open_path mechanisms:');

// Test 1: spawn explorer.exe https://www.youtube.com with windowsHide: true
console.log('Method 1: explorer.exe with windowsHide: true');
const child1 = spawn('explorer.exe', ['https://www.youtube.com'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child1.unref();
console.log('Method 1 spawned PID:', child1.pid);

// Test 2: cmd.exe /c start "" "url"
// console.log('Method 2: cmd /c start');
// exec('cmd /c start "" "https://www.youtube.com"');
