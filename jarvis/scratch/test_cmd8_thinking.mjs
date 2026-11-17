import { createAgentSession } from '../bridge/runner.mjs';
import { windowsServer } from '../bridge/windows.mjs';

const winMcp = windowsServer({ allowWrites: false });

const options = {
  mcpServers: { spark_windows: winMcp },
  canUseTool: async (name) => {
    console.log('[canUseTool Asked]:', name);
    return { behavior: 'allow' };
  },
};

async function* makePrompt(text) {
  yield { message: { content: text } };
}

async function testCmd8() {
  console.log('--- Testing Command 8: "Open my Spark project folder" ---');
  const session = createAgentSession(makePrompt('Open my Spark project folder'), options);

  const timer = setTimeout(() => {
    console.error('TIMED OUT AFTER 15 SECONDS! (Stuck in THINKING)');
    process.exit(1);
  }, 15000);

  try {
    for await (const evt of session) {
      console.log('[EVT]', evt.type, evt.subtype || '', evt.event?.type || '');
      if (evt.type === 'stream_event' && evt.event?.delta?.text) {
        process.stdout.write(evt.event.delta.text);
      }
      if (evt.type === 'result') {
        console.log('\n[Result]:', evt.result || evt.errors);
      }
    }
    clearTimeout(timer);
    console.log('\nCompleted successfully.');
  } catch (err) {
    console.error('Session error:', err);
  }
}

testCmd8();
