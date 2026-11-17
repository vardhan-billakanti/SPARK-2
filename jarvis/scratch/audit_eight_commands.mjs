import { detectFastPathAction, classifyTurnIntent } from '../bridge/orchestrator.mjs';
import { getSparkWorkspaceRoot } from '../bridge/windows.mjs';

const testCommands = [
  'Open Calculator',
  'Open YouTube',
  'Search YouTube for Telugu songs',
  'Play a Telugu song',
  'Open Spotify',
  'What is my GPU temperature?',
  'Open Antigravity',
  'Open my Spark project folder'
];

console.log('====================================================');
console.log('SPARK 8-COMMAND AUDIT: TRACING INTENT & FAST-PATH');
console.log('====================================================\n');

for (let i = 0; i < testCommands.length; i++) {
  const cmd = testCommands[i];
  console.log(`--- [Command ${i + 1}] "${cmd}" ---`);
  
  const fast = detectFastPathAction(cmd);
  console.log('  FastPath Detected:', fast ? `${fast.type} -> ${fast.toolName} (Args: ${JSON.stringify(fast.args)})` : 'NULL (Falls back to LLM)');
  
  const intent = classifyTurnIntent(cmd, []);
  console.log('  Intent Classification:', `${intent.provider} (${intent.reason})`);
  
  console.log('');
}
