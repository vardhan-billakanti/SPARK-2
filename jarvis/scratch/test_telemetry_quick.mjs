import { execSync } from 'node:child_process';
import os from 'node:os';

console.log('Testing Telemetry...');

// 1. GPU via nvidia-smi
try {
  const gpuRaw = execSync('nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits', { encoding: 'utf8', timeout: 3000 });
  console.log('GPU raw output:', gpuRaw.trim());
  const [util, memUsed, memTotal, temp] = gpuRaw.trim().split(',').map((s) => parseFloat(s.trim()));
  console.log('Parsed GPU:', { utilPercent: util, vramUsedMB: memUsed, vramTotalMB: memTotal, tempC: temp });
} catch (e) {
  console.error('GPU query error:', e.message);
}

// 2. CPU & Memory via Node OS built-in
const totalMemGB = (os.totalmem() / (1024 ** 3)).toFixed(1);
const freeMemGB = (os.freemem() / (1024 ** 3)).toFixed(1);
const usedMemGB = (totalMemGB - freeMemGB).toFixed(1);
console.log('Memory:', { totalMemGB, usedMemGB, freeMemGB });

// 3. Fast CPU load via WMI
try {
  const cpuRaw = execSync('powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Processor).LoadPercentage"', { encoding: 'utf8', timeout: 3000 });
  console.log('CPU Load %:', cpuRaw.trim());
} catch (e) {
  console.error('CPU query error:', e.message);
}

// 4. Battery
try {
  const batRaw = execSync('powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus) | ConvertTo-Json -Compress"', { encoding: 'utf8', timeout: 3000 });
  console.log('Battery:', batRaw.trim());
} catch (e) {
  console.error('Battery query error:', e.message);
}
