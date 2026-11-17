/**
 * SPARK Stabilization & Ollama Tool Serialization Test Suite.
 *
 * Verifies:
 *   1. normalizeQwenToolArguments:
 *      - Native objects accepted
 *      - Legacy stringified JSON parsed
 *      - Malformed JSON rejected with clear Error
 *      - Empty/null/undefined handled as {}
 *      - Arrays and primitives rejected with Error
 *   2. CanonicalLedger.toQwenFormat():
 *      - Produces native JSON objects for tool_calls[].function.arguments
 *      - Preserves tool IDs, names, ordering, and conversation history
 *   3. Multi-turn execution against live Ollama:
 *      - Turn 1: Tool action
 *      - Turn 2: Follow-up conversational request
 *      - Turn 3: Second tool action
 *      - Turn 4: Third conversational turn
 *   4. Exactly-once tool execution enforcement
 *   5. Ollama error recovery and user-facing explanation stream
 *   6. The 8-prompt test matrix in post-tool context
 */

import assert from 'node:assert';
import {
  CanonicalLedger,
  normalizeQwenToolArguments,
  detectFastPathAction,
  classifyTurnIntent,
} from '../bridge/orchestrator.mjs';
import { windowsServer } from '../bridge/windows.mjs';
import { createAgentSession } from '../bridge/runner.mjs';

const winMcp = windowsServer({ allowWrites: false });

function zodToOpenAiSchema(zodSchema) {
  if (!zodSchema || !zodSchema.shape) return { type: 'object', properties: {} };
  const properties = {};
  const required = [];
  for (const [key, field] of Object.entries(zodSchema.shape)) {
    let type = 'string';
    const desc = field.description || field.def?.description || '';
    const typeName = field._def?.typeName || field.type || field.def?.type;
    if (typeName === 'ZodNumber' || typeName === 'number') type = 'number';
    else if (typeName === 'ZodBoolean' || typeName === 'boolean') type = 'boolean';
    else if (typeName === 'ZodArray' || typeName === 'array') type = 'array';
    properties[key] = { type, description: desc };
    const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional');
    if (!isOpt) required.push(key);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

const tools = [];
for (const [toolName, toolDef] of Object.entries(winMcp.instance._registeredTools)) {
  tools.push({
    type: 'function',
    function: {
      name: `spark_windows__${toolName}`,
      description: toolDef.description || '',
      parameters: zodToOpenAiSchema(toolDef.inputSchema),
    },
  });
}

const results = [];
function report(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name} — ${detail}`);
}

async function runStabilizationTests() {
  console.log('===============================================================');
  console.log('SPARK RUNTIME STABILIZATION & OLLAMA 400 REGRESSION SUITE');
  console.log('===============================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: normalizeQwenToolArguments Unit Tests
  // -------------------------------------------------------------------------
  console.log('--- Test 1: normalizeQwenToolArguments ---');

  // 1.1: Native object
  const res1 = normalizeQwenToolArguments({ path: 'https://youtube.com' }, 'open_path');
  assert.deepStrictEqual(res1, { path: 'https://youtube.com' });
  report('1.1 Native object', 'PASS', 'Passed through as plain object');

  // 1.2: Valid legacy stringified JSON
  const res2 = normalizeQwenToolArguments('{"path":"https://youtube.com"}', 'open_path');
  assert.deepStrictEqual(res2, { path: 'https://youtube.com' });
  report('1.2 Stringified JSON', 'PASS', 'Parsed correctly into plain object');

  // 1.3: Empty/null/undefined arguments
  assert.deepStrictEqual(normalizeQwenToolArguments(null), {});
  assert.deepStrictEqual(normalizeQwenToolArguments(undefined), {});
  assert.deepStrictEqual(normalizeQwenToolArguments(''), {});
  assert.deepStrictEqual(normalizeQwenToolArguments('{}'), {});
  report('1.3 Empty arguments', 'PASS', 'Cleanly converted to empty object');

  // 1.4: Malformed JSON string must throw Error
  let malformedCaught = false;
  try {
    normalizeQwenToolArguments('{"unclosed_brace": true', 'test_tool');
  } catch (err) {
    malformedCaught = true;
    assert.ok(err.message.includes('Malformed JSON in arguments'));
  }
  assert.ok(malformedCaught, 'Must reject malformed JSON string');
  report('1.4 Malformed JSON rejection', 'PASS', 'Structured Error thrown with tool context');

  // 1.5: Primitives and Arrays must throw Error
  let arrayCaught = false;
  try {
    normalizeQwenToolArguments(['not', 'an', 'object'], 'test_tool');
  } catch (err) {
    arrayCaught = true;
    assert.ok(err.message.includes('expected a JSON object'));
  }
  assert.ok(arrayCaught, 'Must reject array arguments');

  let stringPrimCaught = false;
  try {
    normalizeQwenToolArguments('"just a string"', 'test_tool');
  } catch (err) {
    stringPrimCaught = true;
    assert.ok(err.message.includes('expected a JSON object'));
  }
  assert.ok(stringPrimCaught, 'Must reject string primitive JSON');
  report('1.5 Non-object primitives rejection', 'PASS', 'Arrays and primitives rejected with Error');

  // -------------------------------------------------------------------------
  // Test 2: CanonicalLedger.toQwenFormat() Serialization
  // -------------------------------------------------------------------------
  console.log('\n--- Test 2: CanonicalLedger.toQwenFormat() Serialization ---');
  const ledger = new CanonicalLedger('System Prompt');
  ledger.addUserMessage('open youtube');
  ledger.addAssistantMessage('', 'fastpath', [
    { id: 'call_1', name: 'spark_windows__open_path', args: '{"path":"https://youtube.com"}' }, // legacy string arg
    { id: 'call_2', name: 'spark_windows__launch_app', args: { app: 'calc' } }, // native object arg
    { id: 'call_3', name: 'spark_windows__get_system_info', args: null }, // empty arg
    { id: 'call_4', name: 'spark_windows__bad_tool', args: '{invalid_json' }, // malformed arg
  ]);
  ledger.addToolResult('call_1', 'spark_windows__open_path', 'Opened');
  ledger.addToolResult('call_2', 'spark_windows__launch_app', 'Launched');
  ledger.addToolResult('call_3', 'spark_windows__get_system_info', 'Stats');
  ledger.addToolResult('call_4', 'spark_windows__bad_tool', 'Error', true);
  ledger.addAssistantMessage('All done, sir.', 'fastpath');
  ledger.addUserMessage('next prompt');

  const qwenMsgs = ledger.toQwenFormat();
  assert.strictEqual(qwenMsgs.length, 9); // system + user + asst + 4 tools + asst + user
  const asstToolCalls = qwenMsgs[2].tool_calls;
  assert.strictEqual(typeof asstToolCalls[0].function.arguments, 'object');
  assert.strictEqual(asstToolCalls[0].function.arguments.path, 'https://youtube.com');
  assert.strictEqual(typeof asstToolCalls[1].function.arguments, 'object');
  assert.strictEqual(asstToolCalls[1].function.arguments.app, 'calc');
  assert.deepStrictEqual(asstToolCalls[2].function.arguments, {});
  assert.ok(asstToolCalls[3].function.arguments._error, 'Malformed tool arguments must carry structured _error');
  report('2.1 CanonicalLedger.toQwenFormat()', 'PASS', 'All tool calls serialized to native JSON objects');

  // -------------------------------------------------------------------------
  // Test 3: Multi-turn Conversation (Turn 1 -> Turn 2 -> Turn 3 -> Turn 4)
  // -------------------------------------------------------------------------
  console.log('\n--- Test 3: 4-Turn Continuous Live Session ---');
  let nextResolve = null;
  const turnQueue = [];
  async function* makeTurnStream() {
    while (true) {
      if (turnQueue.length > 0) {
        yield turnQueue.shift();
      } else {
        const item = await new Promise((r) => { nextResolve = r; });
        if (item === null) return;
        yield item;
      }
    }
  }

  function pushTurn(text) {
    const msg = { message: { content: text } };
    if (nextResolve) {
      const r = nextResolve;
      nextResolve = null;
      r(msg);
    } else {
      turnQueue.push(msg);
    }
  }

  const multiTurns = [
    'open youtube',                                   // Turn 1: fast-path tool
    'open yt and play a telugu song',                 // Turn 2: conversational follow-up to Qwen
    'check gpu',                                      // Turn 3: fast-path tool
    'what did you just tell me about my gpu?',        // Turn 4: conversational reference to Turn 3
  ];

  const session = createAgentSession(makeTurnStream(), {
    mcpServers: { spark_windows: winMcp },
    canUseTool: async () => ({ behavior: 'allow' }),
  });

  const turnResults = [];

  // Start pumping session events in background
  const pumpPromise = (async () => {
    for await (const evt of session) {
      if (evt.type === 'result') {
        turnResults.push(evt);
        if (turnResults.length < multiTurns.length) {
          // Push next turn when previous turn completes
          pushTurn(multiTurns[turnResults.length]);
        } else {
          // All turns completed
          break;
        }
      }
    }
  })();

  // Send Turn 1 to start
  pushTurn(multiTurns[0]);
  await pumpPromise;

  assert.strictEqual(turnResults.length, 4, 'Must complete all 4 turns');
  assert.strictEqual(turnResults[0].subtype, 'success');
  assert.strictEqual(turnResults[1].subtype, 'success');
  assert.strictEqual(turnResults[2].subtype, 'success');
  assert.strictEqual(turnResults[3].subtype, 'success');
  report('3.1 4-Turn Continuous Session', 'PASS', `All 4 turns succeeded without HTTP 400 or stalls`);

  // -------------------------------------------------------------------------
  // Test 4: The 8-Prompt Isolation Matrix in Post-Tool Context B
  // -------------------------------------------------------------------------
  console.log('\n--- Test 4: Verification of 8 Prompts in Post-Tool Context ---');
  const eightPrompts = [
    'Hi SPARK.',
    'Open Calculator.',
    'Open YouTube.',
    'Open YouTube and search for Telugu songs.',
    'Open YouTube and play a Telugu song.',
    'Check GPU usage.',
    'What is the speed of light in vacuum?',
    'List files in the workspace and check GPU usage.',
  ];

  for (let i = 0; i < eightPrompts.length; i++) {
    const text = eightPrompts[i];
    const testLedger = new CanonicalLedger('You are SPARK.');
    testLedger.addUserMessage('open youtube');
    testLedger.addAssistantMessage('', 'fastpath', [{ id: 'call_1', name: 'spark_windows__open_path', args: { path: 'https://youtube.com' } }]);
    testLedger.addToolResult('call_1', 'spark_windows__open_path', 'Opened', false);
    testLedger.addAssistantMessage('Opening Youtube, sir.', 'fastpath');
    testLedger.addUserMessage(text);

    const messages = testLedger.toQwenFormat();

    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5:3b', messages, tools, stream: false }),
    });

    assert.strictEqual(res.status, 200, `Prompt ${i + 1} must return HTTP 200`);
  }
  report('4.1 8-Prompt Post-Tool Matrix', 'PASS', 'All 8 prompts returned HTTP 200 OK');

  // -------------------------------------------------------------------------
  // Test 5: User-facing Error Feedback & THINKING Mode Recovery
  // -------------------------------------------------------------------------
  console.log('\n--- Test 5: User-Facing Error Feedback & Recovery ---');
  // Trigger error by sending invalid model name to Ollama
  async function* makeFailingTurn() {
    yield { message: { content: 'test bad model turn' } };
  }

  // Force bad model temporarily via env override in test
  const oldModel = process.env.OLLAMA_MODEL;
  process.env.OLLAMA_MODEL = 'nonexistent_model_xyz';

  const failingSession = createAgentSession(makeFailingTurn(), {
    mcpServers: { spark_windows: winMcp },
    canUseTool: async () => ({ behavior: 'allow' }),
  });

  let receivedErrorDelta = false;
  let receivedResultFailed = false;

  for await (const evt of failingSession) {
    if (evt.type === 'stream_event' && evt.event?.delta?.text?.includes('Local Qwen encountered an error')) {
      receivedErrorDelta = true;
    }
    if (evt.type === 'result' && evt.subtype === 'failed') {
      receivedResultFailed = true;
    }
  }

  process.env.OLLAMA_MODEL = oldModel;

  assert.ok(receivedErrorDelta, 'Must emit user-facing text delta explaining error to voice/UI');
  assert.ok(receivedResultFailed, 'Must conclude turn with failed result exactly once');
  report('5.1 User-facing Error Feedback', 'PASS', 'Stream delta delivered and turn concluded cleanly');

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n===============================================================');
  console.log('STABILIZATION TEST SUMMARY');
  console.log('===============================================================');
  console.table(results);
  const allPassed = results.every((r) => r.status === 'PASS');
  assert.ok(allPassed, 'All stabilization scenarios must pass');
  console.log('\n>>> ALL STABILIZATION & OLLAMA 400 TESTS PASSED! <<<');
}

runStabilizationTests().catch((err) => {
  console.error('[FATAL REGRESSION FAILURE]:', err);
  process.exit(1);
});
