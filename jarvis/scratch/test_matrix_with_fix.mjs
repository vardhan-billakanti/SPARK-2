import { CanonicalLedger } from '../bridge/orchestrator.mjs';
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

class FixedCanonicalLedger extends CanonicalLedger {
  toQwenFormat() {
    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }

    for (const turn of this.turns) {
      if (turn.role === 'user') {
        messages.push({ role: 'user', content: turn.content });
      } else if (turn.role === 'assistant') {
        const msg = { role: 'assistant', content: turn.content || '' };
        if (turn.toolCalls && turn.toolCalls.length > 0) {
          msg.tool_calls = turn.toolCalls.map((tc) => {
            let parsedArgs = tc.args || {};
            if (typeof parsedArgs === 'string') {
              try {
                parsedArgs = JSON.parse(parsedArgs);
              } catch {
                parsedArgs = {};
              }
            }
            return {
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: parsedArgs,
              },
            };
          });
        }
        messages.push(msg);
      } else if (turn.role === 'tool') {
        messages.push({
          role: 'tool',
          tool_call_id: turn.toolUseId,
          name: turn.toolName,
          content: turn.content,
        });
      }
    }

    return messages;
  }
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
  console.log('VERIFYING PROPOSED FIX FOR ALL 8 PROMPTS IN POST-TOOL CONTEXT B');
  console.log('================================================================\n');

  for (let i = 0; i < prompts.length; i++) {
    const text = prompts[i];
    const ledger = new FixedCanonicalLedger('You are SPARK, an advanced desktop AI assistant for Windows.');
    ledger.addUserMessage('open youtube');
    ledger.addAssistantMessage('', 'fastpath', [{ id: 'call_1', name: 'spark_windows__open_path', args: { path: 'https://www.youtube.com' } }]);
    ledger.addToolResult('call_1', 'spark_windows__open_path', 'Opened https://www.youtube.com in Windows.', false);
    ledger.addAssistantMessage('Opening Youtube, sir.', 'fastpath');
    ledger.addUserMessage(text);

    const messages = ledger.toQwenFormat();

    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5:3b', messages, tools, stream: false }),
    });

    const status = res.status;
    const body = await res.text();
    console.log(`Prompt ${i + 1}: "${text}" -> HTTP ${status}: ${status === 200 ? 'SUCCESS' : body.slice(0, 100)}`);
  }
}

runMatrix();
