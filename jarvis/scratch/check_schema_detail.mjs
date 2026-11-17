import { windowsServer } from '../bridge/windows.mjs';

const ws = windowsServer({ allowWrites: false });
const toolDef = ws.instance._registeredTools['launch_app'];

console.log('toolDef keys:', Object.keys(toolDef));
console.log('toolDef.inputSchema.shape:', toolDef.inputSchema.shape);
console.log('toolDef.inputSchema.def:', toolDef.inputSchema.def);
