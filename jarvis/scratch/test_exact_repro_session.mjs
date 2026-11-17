import { createAgentSession } from '../bridge/runner.mjs';
import { windowsServer } from '../bridge/windows.mjs';

const winMcp = windowsServer({ allowWrites: false });

const options = {
  mcpServers: { spark_windows: winMcp },
  canUseTool: async () => ({ behavior: 'allow' }),
};

async function* makeTurnStream(turns) {
  for (const text of turns) {
    yield { message: { content: text } };
  }
}

async function runTest() {
  console.log('Testing full session with 2 turns:');
  console.log('Turn 1: "open youtube"');
  console.log('Turn 2: "open yt and play a telugu song"\n');

  const turns = ['open youtube', 'open yt and play a telugu song'];
  const session = createAgentSession(makeTurnStream(turns), options);

  try {
    for await (const evt of session) {
      if (evt.type === 'stream_event' && evt.event?.delta?.text) {
        process.stdout.write(evt.event.delta.text);
      }
      if (evt.type === 'result') {
        console.log(`\n[Result] ${evt.subtype}:`, evt.result || evt.errors);
      }
    }
  } catch (err) {
    console.error('Session caught error:', err);
  }
}

runTest();
