import { createAgentSession } from '../bridge/runner.mjs';

async function testGeminiRegression() {
  console.log('Testing Gemini provider preservation...');
  const prevProvider = process.env.SPARK_AI_PROVIDER;
  process.env.SPARK_AI_PROVIDER = 'gemini';

  async function* userMessages() {
    yield {
      type: 'user',
      message: { role: 'user', content: 'Say hello in two words.' },
    };
  }

  const session = createAgentSession(userMessages(), {
    mcpServers: {},
    systemPrompt: 'You are SPARK.'
  });

  let textReceived = '';
  for await (const msg of session) {
    if (msg.type === 'stream_event' && msg.event?.delta?.text) {
      textReceived += msg.event.delta.text;
    } else if (msg.type === 'result') {
      console.log('Gemini session result:', msg.subtype, msg.errors || '');
    }
  }

  console.log('Gemini streamed response:', textReceived);
  process.env.SPARK_AI_PROVIDER = prevProvider;
}

testGeminiRegression().catch(console.error);
