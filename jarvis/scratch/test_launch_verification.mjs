import { execSync, spawn } from 'node:child_process';

function isProcessRunning(procPattern) {
  try {
    const stdout = execSync('tasklist /FO CSV /NH', { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const pattern = procPattern instanceof RegExp ? procPattern : new RegExp(procPattern, 'i');
    return stdout.split(/\r?\n/).some(line => pattern.test(line));
  } catch {
    return false;
  }
}

async function launchAndVerify(displayName, target, procPattern) {
  console.log(`Checking if ${displayName} is already running...`);
  if (isProcessRunning(procPattern)) {
    console.log(`-> ${displayName} is ALREADY RUNNING.`);
    return { ok: true, alreadyRunning: true };
  }

  console.log(`Launching ${displayName} via cmd /c start "" "${target}"...`);
  const child = spawn('cmd.exe', ['/c', 'start', '""', target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  let verified = false;
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (isProcessRunning(procPattern)) {
      verified = true;
      break;
    }
  }

  console.log(`-> ${displayName} launch verification:`, verified ? 'SUCCESS' : 'FAILED');
  return { ok: verified, alreadyRunning: false };
}

async function run() {
  // Test Calculator
  const calcRes = await launchAndVerify('Calculator', 'calc.exe', /calc|CalculatorApp/i);
  console.log('Calculator result:', calcRes);

  if (calcRes.ok && !calcRes.alreadyRunning) {
    await new Promise(r => setTimeout(r, 1000));
    execSync('taskkill /F /IM CalculatorApp.exe', { stdio: 'ignore' });
    console.log('Cleaned up Calculator test instance.');
  }

  // Test Spotify (which is already running)
  const spotRes = await launchAndVerify('Spotify', 'spotify.exe', /spotify/i);
  console.log('Spotify result:', spotRes);
}

run();
