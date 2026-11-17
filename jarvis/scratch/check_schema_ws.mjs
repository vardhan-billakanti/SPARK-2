import { windowsServer } from '../bridge/windows.mjs';

const ws = windowsServer({ allowWrites: false });
const toolDef = ws.instance._registeredTools['launch_app'];

console.log('Tool description:', toolDef.description);
console.log('inputSchema:', toolDef.inputSchema);
