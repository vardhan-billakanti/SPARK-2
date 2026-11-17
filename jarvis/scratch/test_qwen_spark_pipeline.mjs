import WebSocket from 'ws';

const commands = [
  { id: 'turn_1', text: 'Hello Spark', label: '1. Hello Spark' },
  { id: 'turn_2', text: 'Write a Python palindrome function.', label: '2. Write a Python palindrome function.' },
  { id: 'turn_3', text: 'Open Calculator.', label: '3. Open Calculator.' },
  { id: 'turn_4', text: 'Open YouTube.', label: '4. Open YouTube.' },
  { id: 'turn_5', text: 'YouTube open cheyyi.', label: '5. YouTube open cheyyi.' }
];

async function runPipeline() {
  console.log('==================================================');
  console.log('SPARK LOCAL QWEN3.5 4B END-TO-END PIPELINE TEST');
  console.log('==================================================\n');

  const ws = new WebSocket('ws://localhost:8787', {
    headers: { Origin: 'http://localhost:5173' }
  });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  console.log('Connected to Spark WebSocket bridge at ws://localhost:8787\n');

  const results = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    console.log(`\n>>> EXECUTING TEST [${cmd.label}] >>>`);
    console.log(`User Prompt: "${cmd.text}"`);

    const turnResult = await new Promise((resolve) => {
      let accumulated = '';
      const toolsCalled = [];
      const startTime = Date.now();
      let firstTokenTime = null;
      let tokenCount = 0;

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.ask && msg.ask !== cmd.id) return;

          if (msg.type === 'text') {
            if (!firstTokenTime) {
              firstTokenTime = Date.now();
            }
            tokenCount++;
            accumulated += msg.delta;
            process.stdout.write(msg.delta);
          } else if (msg.type === 'tool') {
            console.log(`\n[UI EVENT: TOOL CALLED] -> ${msg.name}`);
            toolsCalled.push(msg.name);
          } else if (msg.type === 'done') {
            const endTime = Date.now();
            const totalMs = endTime - startTime;
            const ttftMs = firstTokenTime ? firstTokenTime - startTime : totalMs;
            const tps = totalMs > 0 ? ((tokenCount / (totalMs / 1000)).toFixed(2)) : 'N/A';

            ws.off('message', handler);
            resolve({
              cmd: cmd.text,
              response: accumulated || msg.text,
              toolsCalled,
              ttftMs,
              totalMs,
              tokenCount,
              tps,
              status: 'SUCCESS'
            });
          } else if (msg.type === 'error') {
            const endTime = Date.now();
            ws.off('message', handler);
            resolve({
              cmd: cmd.text,
              response: msg.message,
              toolsCalled,
              ttftMs: null,
              totalMs: endTime - startTime,
              tokenCount: 0,
              tps: 0,
              status: 'ERROR: ' + msg.message
            });
          }
        } catch (e) {
          console.error('Frame parse error:', e);
        }
      };

      ws.on('message', handler);

      // Send ask
      ws.send(JSON.stringify({
        type: 'ask',
        text: cmd.text,
        id: cmd.id
      }));
    });

    console.log(`\n\n--- [TEST ${i + 1} METRICS] ---`);
    console.log(`Status: ${turnResult.status}`);
    console.log(`TTFT: ${turnResult.ttftMs} ms`);
    console.log(`Total Turn Duration: ${turnResult.totalMs} ms`);
    console.log(`Tools Invoked: ${JSON.stringify(turnResult.toolsCalled)}`);
    console.log(`Chunks/Tokens received: ${turnResult.tokenCount}`);
    results.push(turnResult);

    // Short cool-down between turns
    await new Promise(r => setTimeout(r, 1000));
  }

  ws.close();

  console.log('\n==================================================');
  console.log('SUMMARY TABLE:');
  console.log('==================================================');
  console.table(results.map(r => ({
    Command: r.cmd,
    Status: r.status,
    Tools: r.toolsCalled.join(', ') || 'None',
    'TTFT (ms)': r.ttftMs,
    'Total (ms)': r.totalMs,
    'Chunks/Deltas': r.tokenCount
  })));
}

runPipeline().catch(err => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
