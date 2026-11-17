import { CanonicalLedger, detectFastPathAction, classifyTurnIntent } from '../bridge/orchestrator.mjs';
import { windowsServer } from '../bridge/windows.mjs';

const winMcp = windowsServer({ allowWrites: false });

function zodToOpenAiSchema(zodSchema) {
  if (!zodSchema || !zodSchema.shape) return { type: 'object', properties: {} };
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(zodSchema.shape)) {
    let type = 'string';
    const desc = field.description || field.def?.description || '';
    const typeName = field._def?.typeName || field.type || field.def?.type;
    if (typeName === 'ZodNumber' || typeName === 'number') type = 'number';
    else if (typeName === 'ZodBoolean' || typeName === 'boolean') type = 'boolean';
    else if (typeName === 'ZodArray' || typeName === 'array') type = 'array';
    properties[key] = { type, description: desc };
    const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional');
    if (!isOpt) required.push(key);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

const tools = [];
for (const [toolName, toolDef] of Object.entries(winMcp.instance._registeredTools)) {
  tools.push({
    type: 'function',
    function: {
      name: `spark_windows__${toolName}`,
      description: toolDef.description || '',
      parameters: zodToOpenAiSchema(toolDef.inputSchema),
    },
  });
}

const prompts = [
  'Hi SPARK.',
  'Open Calculator.',
  'Open YouTube.',
  'Open YouTube and search for Telugu songs.',
  'Open YouTube and play a Telugu song.',
  'Check GPU usage.',
  'What is the speed of light in vacuum?',
  'List files in the workspace and check GPU usage.',
];

async function runMatrix() {
  console.log('================================================================');
  console.log('ISOLATION MATRIX: CONTEXT A (CLEAN TURN 1) VS CONTEXT B (POST-TOOL TURN 2)');
  console.log('================================================================\n');

  for (let i = 0; i < prompts.length; i++) {
    const text = prompts[i];
    console.log(`\n================== PROMPT ${i + 1}: "${text}" ==================`);
    const fastAction = detectFastPathAction(text);
    console.log(`Fast-path matched: ${fastAction ? fastAction.type : 'NONE'}`);

    // Context A: Fresh ledger (Turn 1)
    const ledgerA = new CanonicalLedger('You are SPARK, an advanced desktop AI assistant for Windows.');
    ledgerA.addUserMessage(text);
    const messagesA = ledgerA.toQwenFormat();

    const resA = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5:3b', messages: messagesA, tools, stream: false }),
    });

    const statusA = resA.status;
    const bodyA = await resA.text();
    console.log(`Context A (Clean Turn 1) -> HTTP ${statusA}: ${statusA === 200 ? 'SUCCESS' : bodyA.slice(0, 100)}`);

    // Context B: Turn 2 following "open youtube" with current unpatched toQwenFormat()
    const ledgerB = new CanonicalLedger('You are SPARK, an advanced desktop AI assistant for Windows.');
    // Simulate Turn 1: open youtube
    ledgerB.addUserMessage('open youtube');
    ledgerB.addAssistantMessage('', 'fastpath', [{ id: 'call_1', name: 'spark_windows__open_path', args: { path: 'https://www.youtube.com' } }]);
    ledgerB.addToolResult('call_1', 'spark_windows__open_path', 'Opened https://www.youtube.com in Windows.', false);
    ledgerB.addAssistantMessage('Opening Youtube, sir.', 'fastpath');
    // Turn 2
    ledgerB.addUserMessage(text);
    const messagesB = ledgerB.toQwenFormat(); // Current unpatched stringified arguments!

    const resB = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5:3b', messages: messagesB, tools, stream: false }),
    });

    const statusB = resB.status;
    const bodyB = await resB.text();
    console.log(`Context B (Post-Tool Turn 2) -> HTTP ${statusB}: ${statusB === 200 ? 'SUCCESS' : bodyB.slice(0, 100)}`);
  }
}

runMatrix();
