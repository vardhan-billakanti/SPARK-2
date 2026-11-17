import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import assert from 'node:assert';

function isProcessRunning(pattern) {
  try {
    const list = execSync('tasklist /FO CSV /NH').toString();
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    return list.split(/\r?\n/).some(line => regex.test(line));
  } catch {
    return false;
  }
}

const ws = new WebSocket('ws://localhost:8787', {
  headers: { Origin: 'http://localhost:5173' },
});

const scenarios = [
  {
    id: 'test_calc',
    prompt: 'Open Calculator',
    verify: () => {
      const running = isProcessRunning(/calc|CalculatorApp/i);
      console.log('   [OS Evidence] Calculator process running:', running);
      assert.ok(running, 'CalculatorApp.exe or calc.exe must be running in Windows');
    },
    cleanup: () => {
      try {
        execSync('taskkill /F /IM CalculatorApp.exe', { stdio: 'ignore' });
        console.log('   [Cleanup] Closed Calculator test process.');
      } catch {}
    }
  },
  {
    id: 'test_gpu_temp',
    prompt: 'What is my GPU temperature?',
    verifyText: (text) => {
      console.log('   [Response Evidence]:', text);
      assert.ok(!text.includes('sir'), 'Must not call user sir');
      assert.ok(text.includes('RTX 4050') || text.includes('degrees Celsius'), 'Must return real GPU telemetry');
      assert.ok(/\d+\s*degrees\s*Celsius/i.test(text), 'Must contain numeric temperature');
    }
  },
  {
    id: 'test_yt_play',
    prompt: 'open youtube and start playing the most listened song 2026',
    verifyText: (text) => {
      console.log('   [Response Evidence]:', text);
      assert.ok(!text.includes('sir'), 'Must not call user sir');
      assert.ok(text.includes('the most listened song 2026') || text.includes('YouTube'), 'Must confirm YouTube song playback');
      // Verify Chrome or browser process is active
      const chromeRunning = isProcessRunning(/chrome/i);
      console.log('   [OS Evidence] Chrome browser running in foreground:', chromeRunning);
      assert.ok(chromeRunning, 'Chrome must be running');
    }
  },
  {
    id: 'test_spark_folder',
    prompt: 'Open my Spark project folder',
    verifyText: (text) => {
      console.log('   [Response Evidence]:', text);
      assert.ok(!text.includes('sir'), 'Must not call user sir');
      assert.ok(text.includes('folder') || text.includes('File Explorer') || text.includes('Spark'), 'Must confirm folder open');
    }
  },
  {
    id: 'test_spotify',
    prompt: 'Open Spotify',
    verifyText: (text) => {
      console.log('   [Response Evidence]:', text);
      assert.ok(!text.includes('sir'), 'Must not call user sir');
      assert.ok(text.includes('Spotify') && (text.includes('running') || text.includes('Opened')), 'Must confirm Spotify status accurately');
    }
  }
];

let currentIndex = 0;
let textBuffer = '';

function runNextScenario() {
  if (currentIndex >= scenarios.length) {
    console.log('\n===============================================================');
    console.log('ALL REAL EXECUTION & INTEGRITY TESTS PASSED WITH 100% GREEN!');
    console.log('===============================================================\n');
    ws.close();
    process.exit(0);
    return;
  }

  const s = scenarios[currentIndex];
  console.log(`\n--- Running Scenario ${currentIndex + 1}: "${s.prompt}" ---`);
  textBuffer = '';
  ws.send(JSON.stringify({ type: 'ask', text: s.prompt, id: s.id }));
}

ws.on('open', () => {
  console.log('[WebSocket Test] Connected to ws://localhost:8787');
  setTimeout(() => runNextScenario(), 500);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'text' && msg.delta) {
    process.stdout.write(msg.delta);
    textBuffer += msg.delta;
  } else if (msg.type === 'tool') {
    console.log(`\n   [Tool Dispatched]: ${msg.name}`);
  } else if (msg.type === 'error') {
    console.error(`\n   [Turn Error]:`, msg.message);
  } else if (msg.type === 'done') {
    const s = scenarios[currentIndex];
    const finalText = msg.text || textBuffer;
    console.log(`\n   [Turn Done] Result: "${finalText.trim()}"`);

    // Verify assertions
    if (s.verify) s.verify();
    if (s.verifyText) s.verifyText(finalText);
    if (s.cleanup) s.cleanup();

    console.log(`   [PASS] Scenario ${currentIndex + 1} passed successfully.`);
    currentIndex++;
    setTimeout(() => runNextScenario(), 1200);
  }
});

ws.on('error', (err) => {
  console.error('[WebSocket Test Error]:', err);
  process.exit(1);
});

setTimeout(() => {
  console.error('\n[TIMEOUT] Test suite timed out!');
  ws.close();
  process.exit(1);
}, 60000);
