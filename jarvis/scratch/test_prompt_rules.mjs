import http from 'node:http';

const testPrompts = [
  'Hello Spark',
  'Write a Python palindrome function.',
  'Open Calculator',
  'Open YouTube',
  'YouTube open cheyyi'
];

const systemPrompt = `You are SPARK, an advanced desktop AI assistant for Windows.

CRITICAL RULES FOR TOOL CALLING:
1. CONVERSATION & GREETINGS: For greetings ("hello", "hi", "how are you"), chit-chat, or introductions, reply directly with friendly text. NEVER invoke any tool.
2. CODING & QUESTIONS: Provide code snippets, explanations, and answers directly in text. NEVER launch an application or editor (like Notepad or VS Code) for a coding question unless the user explicitly commands "open notepad", "open in vscode", or "save to file".
3. TOOL INVOCATION: ONLY invoke tools when the user's command explicitly requests an external action (such as "Open Calculator", "Open YouTube", "Launch Chrome", "YouTube open cheyyi").
4. ACCURACY: Never claim an action was performed unless the tool actually executed.
5. MULTILINGUAL: Understand Telugu and Telugu-English mixed commands (e.g. "YouTube open cheyyi" means open YouTube in the browser). Always respond in clear English.`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'spark_windows__launch_app',
      description: 'Launch a desktop application on Windows. Use ONLY when the user explicitly asks to open, launch, or run an application (e.g., calc, chrome, notepad, wt).',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Application name or executable, e.g. "calc", "chrome", "notepad", "wt"' },
          args: { type: 'string', description: 'Optional command line arguments or URL' }
        },
        required: ['app']
      }
    }
  }
];

async function testOne(prompt) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'qwen3.5:4b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      stream: false,
      think: false,
      tools
    });

    const req = http.request(
      {
        host: 'localhost',
        port: 11434,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => buf += c.toString());
        res.on('end', () => {
          try {
            const data = JSON.parse(buf);
            resolve({
              prompt,
              content: data.message?.content,
              tool_calls: data.message?.tool_calls || []
            });
          } catch (e) {
            resolve({ prompt, error: e.message, raw: buf });
          }
        });
      }
    );
    req.write(payload);
    req.end();
  });
}

async function run() {
  for (const p of testPrompts) {
    console.log(`\nTesting: "${p}"`);
    const res = await testOne(p);
    console.log('Tools called:', res.tool_calls.map(t => `${t.function.name}(${JSON.stringify(t.function.arguments)})`));
    console.log('Response content:', (res.content || '').slice(0, 150));
  }
}

run().catch(console.error);
