import { windowsServer } from '../bridge/windows.mjs';
import { displayServer } from '../bridge/panels.mjs';
import { uiServer } from '../bridge/ui.mjs';
import { chromeServer } from '../bridge/chrome.mjs';
import { visionServer } from '../bridge/vision.mjs';


const mcpServers = {
  jarvis: displayServer(() => {}, () => {}),
  jarvis_ui: uiServer(() => {}),
  jarvis_chrome: chromeServer({ allowWrites: false }),
  jarvis_eyes: visionServer(() => {}),
  spark_windows: windowsServer({ allowWrites: false }),
};

for (const [sKey, s] of Object.entries(mcpServers)) {
  const regTools = s?.instance?._registeredTools;
  console.log(`Server: ${sKey}, tools registered:`, Object.keys(regTools || {}));
}
