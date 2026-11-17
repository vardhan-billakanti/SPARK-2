import WebSocket from '../node_modules/ws/index.js';

const ws = new WebSocket('ws://localhost:8787', { headers: { Origin: 'http://localhost:5173' } });

ws.on('open', () => {
  console.log('[CLIENT] Connected to Bridge ws://localhost:8787');
  setTimeout(() => {
    console.log('[CLIENT] Sending: "open YouTube and play song"');
    ws.send(JSON.stringify({ type: 'ask', text: 'open YouTube and play song', id: 't_1' }));
  }, 500);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'tool') {
    console.log('[CLIENT] Tool invoked:', msg.name);
  }
  if (msg.type === 'text') {
    process.stdout.write(msg.delta);
  }
  if (msg.type === 'done') {
    console.log('\n[CLIENT] Turn completed for ask:', msg.ask);
    if (msg.ask === 't_1') {
      setTimeout(() => {
        console.log('[CLIENT] Sending: "open spotify"');
        ws.send(JSON.stringify({ type: 'ask', text: 'open spotify', id: 't_2' }));
      }, 500);
    } else if (msg.ask === 't_2') {
      console.log('[CLIENT] All tests finished!');
      ws.close();
      process.exit(0);
    }
  }
});

ws.on('error', (err) => {
  console.error('[CLIENT] WebSocket error:', err.message);
  process.exit(1);
});
