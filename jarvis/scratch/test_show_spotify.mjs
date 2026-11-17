import { spawn, execSync } from 'node:child_process';

console.log('Testing launching Spotify to open its window...');
// Launch spotify: URI protocol or executable via start
execSync('cmd.exe /c start "" "C:\\Users\\vardh\\AppData\\Local\\Microsoft\\WindowsApps\\Spotify.exe"');

setTimeout(() => {
  const ps = execSync(`powershell -NoProfile -Command "Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id, MainWindowTitle, MainWindowHandle | Format-Table -AutoSize"`).toString();
  console.log('Active Spotify Window Process:\n', ps);
  process.exit(0);
}, 2500);
