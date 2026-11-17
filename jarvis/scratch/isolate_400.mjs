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

function extractQwenTools(mcpServers) {
  const tools = [];
  for (const [serverKey, server] of Object.entries(mcpServers || {})) {
    const regTools = server?.instance?._registeredTools;
    if (!regTools) continue;
    for (const [toolName, toolDef] of Object.entries(regTools)) {
      const primaryName = serverKey === 'spark_windows'
        ? `spark_windows__${toolName}`
        : `mcp__${serverKey}__${toolName}`;
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
  return tools;
}

const tools = extractQwenTools({ spark_windows: winMcp });

const fullMessages = [
  { role: "system", content: "You are SPARK, an advanced desktop AI assistant for Windows." },
  { role: "user", content: "open youtube" },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "fast_1794831085129",
        type: "function",
        function: {
          name: "spark_windows__open_path",
          arguments: "{\"path\":\"https://www.youtube.com\"}"
        }
      }
    ]
  },
  {
    role: "tool",
    tool_call_id: "fast_1794831085129",
    name: "spark_windows__open_path",
    content: "Opened https://www.youtube.com in Windows."
  },
  { role: "assistant", content: "Opening Youtube, sir." },
  { role: "user", content: "open yt and play a telugu song" }
];

async function check(name, payload) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`[${res.status}] ${name}:`, text.slice(0, 120));
}

async function run() {
  // Test 1: Full messages, NO tools
  await check('Test 1: Full messages, NO tools', {
    model: 'qwen2.5:3b',
    messages: fullMessages,
    stream: false,
  });

  // Test 2: Single user message WITH tools
  await check('Test 2: Single user message WITH tools', {
    model: 'qwen2.5:3b',
    messages: [{ role: 'user', content: 'open yt and play a telugu song' }],
    tools,
    stream: false,
  });

  // Test 3: Full messages with arguments as parsed OBJECT instead of string in tool_calls
  const messagesWithArgObj = JSON.parse(JSON.stringify(fullMessages));
  messagesWithArgObj[2].tool_calls[0].function.arguments = { path: "https://www.youtube.com" };
  await check('Test 3: arguments as OBJECT in tool_calls', {
    model: 'qwen2.5:3b',
    messages: messagesWithArgObj,
    tools,
    stream: false,
  });

  // Test 4: Tool call message without the second assistant message
  const messagesNoSecondAssistant = [
    fullMessages[0],
    fullMessages[1],
    fullMessages[2],
    fullMessages[3],
    fullMessages[5] // user message
  ];
  await check('Test 4: No second assistant message', {
    model: 'qwen2.5:3b',
    messages: messagesNoSecondAssistant,
    tools,
    stream: false,
  });

  // Test 5: tool_calls function.arguments format test
  const messagesClean = [
    { role: 'user', content: 'open youtube' },
    {
      role: 'assistant',
      tool_calls: [
        {
          function: {
            name: 'spark_windows__open_path',
            arguments: { path: 'https://www.youtube.com' }
          }
        }
      ]
    },
    { role: 'tool', content: 'Opened' },
    { role: 'user', content: 'now search songs' }
  ];
  await check('Test 5: clean arguments obj, no tool_call_id', {
    model: 'qwen2.5:3b',
    messages: messagesClean,
    tools,
    stream: false,
  });
}

run();
