async function test(name, argumentsValue) {
  const payload = {
    model: 'qwen2.5:3b',
    messages: [
      { role: 'user', content: 'open youtube' },
      {
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            function: {
              name: 'spark_windows__open_path',
              arguments: argumentsValue
            }
          }
        ]
      },
      { role: 'tool', content: 'Opened' },
      { role: 'user', content: 'play a song' }
    ],
    stream: false
  };

  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  console.log(`[${res.status}] ${name}:`, text.slice(0, 100));
}

async function run() {
  console.log('Testing arguments as STRING vs OBJECT in Ollama /api/chat:');
  await test('Arguments as STRING: "{\\"path\\":\\"https://www.youtube.com\\"}"', '{"path":"https://www.youtube.com"}');
  await test('Arguments as OBJECT: { path: "https://www.youtube.com" }', { path: "https://www.youtube.com" });
}

run();
