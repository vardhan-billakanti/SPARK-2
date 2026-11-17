import { detectFastPathAction, CanonicalLedger } from '../bridge/orchestrator.mjs';
import { windowsServer } from '../bridge/windows.mjs';

// Setup tools
const winMcp = windowsServer({ allowWrites: false });

function zodToOpenAiSchema(zodSchema) {
  if (!zodSchema || !zodSchema.shape) {
    return { type: 'object', properties: {} };
  }
  const properties = {};
  const required = [];

  for (const [key, field] of Object.entries(zodSchema.shape)) {
    let type = 'string';
    const desc = field.description || field.def?.description || '';
    const typeName = field._def?.typeName || field.type || field.def?.type;

    if (typeName === 'ZodNumber' || typeName === 'number') type = 'number';
    else if (typeName === 'ZodBoolean' || typeName === 'boolean') type = 'boolean';
    else if (typeName === 'ZodArray' || typeName === 'array') type = 'array';
    else if (typeName === 'ZodEnum' || typeName === 'enum') {
      properties[key] = { type: 'string', enum: field._def?.values || field.def?.values, description: desc };
      const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional');
      if (!isOpt) required.push(key);
      continue;
    }

    properties[key] = { type, description: desc };
    const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional');
    if (!isOpt) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function extractQwenTools(mcpServers) {
  const toolMap = new Map();
  const tools = [];

  for (const [serverKey, server] of Object.entries(mcpServers || {})) {
    const regTools = server?.instance?._registeredTools;
    if (!regTools) continue;

    for (const [toolName, toolDef] of Object.entries(regTools)) {
      const primaryName = serverKey === 'spark_windows'
        ? `spark_windows__${toolName}`
        : `mcp__${serverKey}__${toolName}`;

      toolMap.set(primaryName, toolDef);
      tools.push({
        type: 'function',
        function: {
          name: primaryName,
          description: toolDef.description || '',
          parameters: zodToOpenAiSchema(toolDef.inputSchema),
        },
      });
    }
  }

  return { toolMap, tools };
}

async function testReproduction() {
  const ledger = new CanonicalLedger('You are SPARK, an advanced desktop AI assistant for Windows.');
  const { tools } = extractQwenTools({ spark_windows: winMcp });

  console.log('--- Step 1: Simulate Turn 1 ("open youtube") ---');
  const userText1 = 'open youtube';
  ledger.addUserMessage(userText1);
  const fastAction1 = detectFastPathAction(userText1);
  console.log('Fast action 1:', fastAction1?.type);

  const callId = `fast_${Date.now()}`;
  ledger.addAssistantMessage('', 'fastpath', [{ id: callId, name: fastAction1.toolName, args: fastAction1.args }]);
  ledger.addToolResult(callId, fastAction1.toolName, 'Opened https://www.youtube.com in Windows.', false);
  ledger.addAssistantMessage('Opening Youtube, sir.', 'fastpath');

  console.log('\n--- Step 2: Simulate Turn 2 ("open yt and play a telugu song") ---');
  const userText2 = 'open yt and play a telugu song';
  ledger.addUserMessage(userText2);

  const qwenMessages = ledger.toQwenFormat();
  console.log('\n--- Qwen Messages Payload ---');
  console.log(JSON.stringify(qwenMessages, null, 2));

  console.log('\n--- Testing Request to Ollama ---');
  const requestBody = {
    model: 'qwen2.5:3b',
    messages: qwenMessages,
    stream: false,
    options: { num_predict: 350, temperature: 0.7 },
    tools,
  };

  console.log('\n--- Sending to http://127.0.0.1:11434/api/chat ---');
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    console.log('HTTP Status:', res.status, res.statusText);
    const text = await res.text();
    console.log('Ollama Response:', text);
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

testReproduction();
