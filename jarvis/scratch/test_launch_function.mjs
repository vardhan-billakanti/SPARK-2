import { execSync } from 'node:child_process';

function launchDesktopTarget(target, args = []) {
  try {
    const isUri = /^[a-z0-9+.-]+:/i.test(target) && !/^[a-z]:\\/i.test(target);
    let script = '';
    if (isUri) {
      script = `Start-Process '${target.replace(/'/g, "''")}'`;
    } else {
      const escapedTarget = target.replace(/'/g, "''");
      const argString = args.length > 0 ? `-ArgumentList '${args.map(a => a.replace(/'/g, "''")).join("', '")}'` : '';
      script = `Start-Process -FilePath '${escapedTarget}' ${argString}`;
    }
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, {
      timeout: 5000,
      stdio: 'ignore',
      windowsHide: true,
    });
    console.log('Successfully launched:', target);
    return true;
  } catch (err) {
    console.error('Launch failed for', target, err.message);
    return false;
  }
}

launchDesktopTarget('https://www.youtube.com');
launchDesktopTarget('spotify:');
launchDesktopTarget('calc.exe');
