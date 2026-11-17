import { detectFastPathAction, CanonicalLedger, classifyTurnIntent } from '../bridge/orchestrator.mjs';
import { windowsServer } from '../bridge/windows.mjs';

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
  'What is the capital of France and why is it historically significant?',
  'List files in the workspace and check GPU usage.',
];

async function runPromptTest() {
  console.log('====================================================');
  console.log('TESTING 8 USER PROMPTS AGAINST OLLAMA / API & BRIDGE');
  console.log('====================================================\n');

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    console.log(`\n--- Prompt ${i + 1}: "${p}" ---`);
    const fastAction = detectFastPathAction(p);
    const intent = classifyTurnIntent(p);
    console.log(`Fast-path matched: ${fastAction ? fastAction.type : 'NONE (routes to LLM)'}`);
    console.log(`Intent classification: ${intent.provider} (${intent.reason})`);

    // If fast path didn't catch it, it goes to Ollama Qwen
    const reqBody = {
      model: 'qwen2.5:3b',
      messages: [
        { role: 'system', content: 'You are SPARK, an advanced desktop AI assistant for Windows.' },
        { role: 'user', content: p },
      ],
      tools,
      stream: false,
    };

    try {
      const res = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      });

      console.log(`Ollama Status: ${res.status} ${res.statusText}`);
      if (!res.ok) {
        const errText = await res.text();
        console.error(`ERROR Response: ${errText}`);
      } else {
        const data = await res.json();
        const content = data.message?.content || '';
        const toolCalls = data.message?.tool_calls || [];
        console.log(`Response content: "${content.slice(0, 80)}..."`);
        console.log(`Tool calls returned: ${toolCalls.length}`);
        if (toolCalls.length > 0) {
          console.log('Tool calls:', JSON.stringify(toolCalls.map(tc => ({ name: tc.function?.name, args: tc.function?.arguments }))));
        }
      }
    } catch (e) {
      console.error('Fetch exception:', e.message);
    }
  }
}

runPromptTest();
