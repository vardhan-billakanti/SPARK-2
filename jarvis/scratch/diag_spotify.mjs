import { execSync } from 'node:child_process';

console.log('=== SPOTIFY DIAGNOSTIC ===');

try {
  const psOutput = execSync(`powershell -NoProfile -Command "
    Get-Process -Name Spotify -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle, Path | Format-Table -AutoSize
  "`).toString();
  console.log(psOutput);
} catch (e) {
  console.error('Error querying Spotify processes:', e.message);
}

try {
  const winTitle = execSync(`powershell -NoProfile -Command "
    (Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' }).MainWindowTitle
  "`).toString().trim();
  console.log('Active Spotify Main Window Title(s):', JSON.stringify(winTitle));
} catch (e) {
  console.error('Error querying title:', e.message);
}
