import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outPath = path.resolve('test_scr.png');
const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save('${outPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "OK"
} catch {
  Write-Error $_.Exception.Message
} finally {
  $graphics.Dispose()
  $bmp.Dispose()
}
`;

const encoded = Buffer.from(script, 'utf16le').toString('base64');
try {
  const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`).toString();
  console.log('Output:', out);
  console.log('File exists:', fs.existsSync(outPath));
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }
} catch (err) {
  console.error('Error:', err.message);
}
