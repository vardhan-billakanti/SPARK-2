import { detectFastPathAction, CanonicalLedger } from '../bridge/orchestrator.mjs';
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

// Subclass CanonicalLedger with the proposed fix for toQwenFormat()
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

async function testFixedReproduction() {
  const ledger = new FixedCanonicalLedger('You are SPARK, an advanced desktop AI assistant for Windows.');

  console.log('--- Step 1: Simulate Turn 1 ("open youtube") with Fixed Ledger ---');
  const userText1 = 'open youtube';
  ledger.addUserMessage(userText1);
  const fastAction1 = detectFastPathAction(userText1);

  const callId = `fast_${Date.now()}`;
  ledger.addAssistantMessage('', 'fastpath', [{ id: callId, name: fastAction1.toolName, args: fastAction1.args }]);
  ledger.addToolResult(callId, fastAction1.toolName, 'Opened https://www.youtube.com in Windows.', false);
  ledger.addAssistantMessage('Opening Youtube, sir.', 'fastpath');

  console.log('\n--- Step 2: Simulate Turn 2 ("open yt and play a telugu song") ---');
  const userText2 = 'open yt and play a telugu song';
  ledger.addUserMessage(userText2);

  const qwenMessages = ledger.toQwenFormat();
  console.log('Generated Qwen Messages arguments type:', typeof qwenMessages[2].tool_calls[0].function.arguments);

  const requestBody = {
    model: 'qwen2.5:3b',
    messages: qwenMessages,
    stream: false,
    options: { num_predict: 350, temperature: 0.7 },
    tools,
  };

  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  console.log('Ollama Response Status:', res.status, res.statusText);
  const data = await res.json();
  console.log('Ollama Response Message:', JSON.stringify(data.message?.content || data.message?.tool_calls));
}

testFixedReproduction();
