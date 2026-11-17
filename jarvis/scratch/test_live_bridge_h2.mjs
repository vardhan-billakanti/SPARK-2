import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8787', {
  headers: { Origin: 'http://localhost:5173' },
});

ws.on('open', () => {
  console.log('[Live Test] Connected to ws://localhost:8787');
  // Send Telugu-English telemetry fast-path command
  ws.send(JSON.stringify({ type: 'ask', text: 'laptop status ela undi', id: 'ask_live_telugu' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[Live Test] Received event type:', msg.type, msg.event ? msg.event.type : (msg.result ? 'has_result' : ''));
  if (msg.type === 'stream_event' && msg.event?.delta?.text) {
    console.log('[Live Test] Stream text delta:', msg.event.delta.text);
  }
  if (msg.type === 'text') {
    console.log('[Live Test] Spoken speech delta:', msg.delta);
  }
  if (msg.type === 'done') {
    console.log('[Live Test] Turn completed successfully!');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('[Live Test] WS Error:', err);
  process.exit(1);
});

setTimeout(() => {
  console.error('[Live Test] Timed out waiting for response');
  process.exit(1);
}, 8000);
