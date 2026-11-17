import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8787', {
  headers: { Origin: 'http://localhost:5173' },
});

let currentTurn = 0;
const turns = [
  { id: 'turn_1', text: 'open youtube' },
  { id: 'turn_2', text: 'open yt and play a telugu song' },
];

let turnTextBuffer = '';

function sendNextTurn() {
  if (currentTurn >= turns.length) {
    console.log('\n========================================');
    console.log('ALL TURNS COMPLETED');
    console.log('========================================');
    ws.close();
    process.exit(0);
    return;
  }

  const turn = turns[currentTurn];
  console.log(`\n=================== Turn ${currentTurn + 1}: "${turn.text}" (id: ${turn.id}) ===================`);
  turnTextBuffer = '';
  ws.send(JSON.stringify({ type: 'ask', text: turn.text, id: turn.id }));
}

ws.on('open', () => {
  console.log('[Live WS Test] Connected to ws://localhost:8787');
  setTimeout(() => sendNextTurn(), 500);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[RECV]', JSON.stringify(msg));

  if (msg.type === 'text' && msg.delta) {
    turnTextBuffer += msg.delta;
  } else if (msg.type === 'done') {
    console.log(`\n[Done Event] text: "${msg.text}", accumulated textBuffer length: ${turnTextBuffer.length}`);
    currentTurn++;
    setTimeout(() => {
      sendNextTurn();
    }, 1500);
  }
});

ws.on('error', (err) => {
  console.error('[Live WS Test] WS error:', err);
  process.exit(1);
});

setTimeout(() => {
  console.error('[Live WS Test] Timeout');
  process.exit(1);
}, 30000);
