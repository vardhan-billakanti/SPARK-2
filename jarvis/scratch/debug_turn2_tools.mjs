import { createAgentSession } from '../bridge/runner.mjs';
import { windowsServer } from '../bridge/windows.mjs';

const mockChromeServer = {
  instance: {
    listTools: async () => ({
      tools: [
        {
          name: 'chrome_console',
          description: 'Execute console commands in Chrome',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
        {
          name: 'chrome_navigate',
          description: 'Navigate Chrome to a URL',
          inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        },
      ],
    }),
    callTool: async ({ name, arguments: args }) => {
      console.log(`[MockChrome] Called ${name} with`, args);
      return { content: [{ type: 'text', text: 'chrome unavailable or mocked' }] };
    },
  },
};

const winMcp = windowsServer({ allowWrites: false });

const options = {
  mcpServers: {
    spark_windows: winMcp,
    mcp__jarvis_chrome: mockChromeServer,
  },
  canUseTool: async () => ({ behavior: 'allow' }),
};

async function* makeTurnStream(turns) {
  for (const text of turns) {
    yield { message: { content: text } };
  }
}

async function runTest() {
  const turns = ['open youtube', 'open yt and play a telugu song'];
  const session = createAgentSession(makeTurnStream(turns), options);

  for await (const evt of session) {
    console.log('[SESSION EVENT]', evt.type, evt.subtype || '', evt.event?.type || '');
    if (evt.type === 'stream_event' && evt.event?.delta?.text) {
      console.log('  -> delta:', JSON.stringify(evt.event.delta.text));
    }
    if (evt.type === 'result') {
      console.log('  -> result:', JSON.stringify(evt.result || evt.errors));
    }
  }
}

runTest();
