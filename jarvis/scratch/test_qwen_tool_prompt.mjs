import http from 'node:http';

const payload = JSON.stringify({
  model: 'qwen3.5:4b',
  messages: [
    {
      role: 'system',
      content: 'You are SPARK, an advanced desktop AI assistant for Windows. You have tools available to control Windows applications. When asked to open or launch an application, you MUST call the appropriate tool.'
    },
    { role: 'user', content: 'Open Calculator' }
  ],
  stream: false,
  think: false,
  tools: [
    {
      type: 'function',
      function: {
        name: 'spark_windows__launch_app',
        description: 'Launch a desktop application on Windows (e.g. calc, notepad, chrome, code).',
        parameters: {
          type: 'object',
          properties: {
            app: { type: 'string', description: 'Application name, e.g. calc, notepad' }
          },
          required: ['app']
        }
      }
    }
  ]
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
      console.log('Response:', buf);
    });
  }
);
req.write(payload);
req.end();
