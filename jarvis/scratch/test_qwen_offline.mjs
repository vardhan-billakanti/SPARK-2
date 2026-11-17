import { createAgentSession } from '../bridge/runner.mjs';

async function testOffline() {
  console.log('Testing Qwen offline handling...');
  const originalHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = 'http://localhost:59999'; // deliberately offline

  async function* userMessages() {
    yield {
      type: 'user',
      message: { role: 'user', content: 'Hello Spark' },
    };
  }

  const session = createAgentSession(userMessages(), {
    mcpServers: {},
    systemPrompt: 'You are SPARK.'
  });

  for await (const msg of session) {
    console.log('[SESSION MSG]:', msg.type, msg.subtype, msg.errors);
    if (msg.type === 'result' && msg.subtype === 'failed') {
      console.log('PASS: Received expected failed result.');
      if (msg.errors && msg.errors[0] === 'Local Qwen is unavailable. Please make sure Ollama is running.') {
        console.log('PASS: Exact error message matches specification!');
      } else {
        console.log('FAIL: Error message did not match:', msg.errors);
      }
    }
  }

  process.env.OLLAMA_HOST = originalHost;
}

testOffline().catch(console.error);
