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

async function testStreaming() {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5:3b',
      messages: [{ role: 'user', content: 'Open Calculator please' }],
      tools,
      stream: true,
    }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line.trim());
      chunks.push(parsed);
      if (parsed.message?.tool_calls) {
        console.log('Stream chunk tool_calls:', JSON.stringify(parsed.message.tool_calls));
      }
    }
  }

  console.log(`Total chunks: ${chunks.length}`);
}

testStreaming();
