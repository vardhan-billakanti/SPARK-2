import { execSync, spawn } from 'node:child_process';

console.log('Testing cmd /c start mechanism...');
// When cmd is invoked with start, cmd itself can be hidden or synchronous,
// but the started program launches with its normal window!
const child = spawn('cmd.exe', ['/c', 'start', '""', 'calc.exe'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();

setTimeout(() => {
  const list = execSync('tasklist /FO CSV /NH').toString();
  const found = list.split(/\r?\n/).filter(line => /calc/i.test(line));
  console.log('Found calculator:', found.length > 0 ? found[0] : 'NOT FOUND');
  if (found.length > 0) {
    execSync('taskkill /F /IM CalculatorApp.exe');
    console.log('Killed calculator after verification.');
  }
  process.exit(0);
}, 1000);
