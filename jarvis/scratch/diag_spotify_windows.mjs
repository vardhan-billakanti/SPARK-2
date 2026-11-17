import { execSync } from 'node:child_process';

const script = `
$procs = Get-Process -Name Spotify -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    [PSCustomObject]@{
        Id = $p.Id
        MainWindowTitle = $p.MainWindowTitle
        Responding = $p.Responding
        Handle = $p.MainWindowHandle
    }
} | Format-Table -AutoSize
`;

const res = execSync('powershell -NoProfile -Command "' + script.replace(/\r?\n/g, '; ') + '"').toString();
console.log(res);
