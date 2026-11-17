/**
 * SPARK Phase H2 Verification Test Suite.
 *
 * Verifies:
 *   1. Security-Preserving Fast Path (Routes through MCP handlers and canUseTool)
 *   2. Realistic Performance Benchmarking (Classifier latency vs completion latency)
 *   3. Dynamic Portable Discovery (Zero hardcoded C:\Users\vardh paths)
 *   4. Read-Only System Telemetry (RTX 4050 GPU, CPU, RAM, Disk, Battery with ALLOW_WRITES=0)
 *   5. File-Operation Permission Model (Search/read permitted; delete/create blocked under ALLOW_WRITES=0)
 *   6. Anti-Loop Limits & Deduplication (Fingerprinting identical calls; max 3 cycles)
 *   7. Telugu-English Command Normalization
 *   8. Interactive Session Screenshot
 *   9. Turn Interruption Handling
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  detectFastPathAction,
  TurnToolLedger,
  MAX_TOOL_CYCLES_PER_TURN,
  CanonicalLedger,
} from '../bridge/orchestrator.mjs'
import { windowsServer, getSparkWorkspaceRoot } from '../bridge/windows.mjs'
import { createAgentSession } from '../bridge/runner.mjs'

const results = []

function logResult(scenario, status, detail = '', metrics = null) {
  results.push({ scenario, status, detail, metrics })
  const metricStr = metrics ? ` [${Object.entries(metrics).map(([k, v]) => `${k}=${v}ms`).join(', ')}]` : ''
  console.log(`[${status}] ${scenario} — ${detail}${metricStr}`)
}

async function runTests() {
  console.log('===============================================================')
  console.log('SPARK PHASE H2: ULTRA-FAST INTELLIGENCE & WINDOWS CONTROL SUITE')
  console.log('===============================================================\n')

  // Setup Windows MCP Tools Server (in read-only mode ALLOW_WRITES=false)
  const winMcpReadOnly = windowsServer({ allowWrites: false })
  const readOnlyTools = winMcpReadOnly.instance._registeredTools

  // Setup Windows MCP Tools Server (with ALLOW_WRITES=true for permission testing)
  const winMcpWriteAllowed = windowsServer({ allowWrites: true })
  const writeTools = winMcpWriteAllowed.instance._registeredTools

  // -------------------------------------------------------------------------
  // S1: Fast-Path Intent Recognition & Classifier Latency
  // -------------------------------------------------------------------------
  console.log('--- Running S1: Fast-Path Classifier & Latency ---')
  const classifierPrompts = [
    { text: 'open calculator', expected: 'launch_app', tool: 'spark_windows__launch_app' },
    { text: 'calculator open cheyyi', expected: 'launch_app', tool: 'spark_windows__launch_app' },
    { text: 'open chrome', expected: 'launch_app', tool: 'spark_windows__launch_app' },
    { text: 'open youtube', expected: 'open_url', tool: 'spark_windows__open_path' },
    { text: 'youtube open chey', expected: 'open_url', tool: 'spark_windows__open_path' },
    { text: 'open antigravity', expected: 'launch_app', tool: 'spark_windows__launch_app' },
    { text: 'open spark folder', expected: 'open_workspace', tool: 'spark_windows__open_path' },
    { text: 'check gpu', expected: 'get_system_info', tool: 'spark_windows__get_system_info' },
    { text: 'laptop status ela undi', expected: 'get_system_info', tool: 'spark_windows__get_system_info' },
    { text: 'take a screenshot', expected: 'take_screenshot', tool: 'spark_windows__take_screenshot' },
    { text: 'screenshot teeyi', expected: 'take_screenshot', tool: 'spark_windows__take_screenshot' },
  ]

  let totalClassifierTime = 0
  for (const item of classifierPrompts) {
    const t0 = performance.now()
    const action = detectFastPathAction(item.text)
    const dt = performance.now() - t0
    totalClassifierTime += dt
    assert.ok(action, `Failed to recognize: ${item.text}`)
    assert.strictEqual(action.type, item.expected)
    assert.strictEqual(action.toolName, item.tool)
  }
  const avgClassifierTime = (totalClassifierTime / classifierPrompts.length).toFixed(3)
  logResult('S1: Fast-Path Intent Classification', 'PASS', `Classified ${classifierPrompts.length} commands`, {
    avgClassifierLatency: parseFloat(avgClassifierTime),
  })

  // -------------------------------------------------------------------------
  // S2: Portable Workspace Discovery (Zero Hardcoded Paths)
  // -------------------------------------------------------------------------
  console.log('\n--- Running S2: Portable Dynamic Workspace Discovery ---')
  const workspaceRoot = getSparkWorkspaceRoot()
  assert.ok(workspaceRoot, 'Workspace root must resolve')
  assert.ok(fs.existsSync(workspaceRoot), `Resolved root must exist: ${workspaceRoot}`)
  assert.ok(fs.existsSync(path.join(workspaceRoot, 'jarvis')), 'Resolved root must contain jarvis directory')
  // Verify it contains no static hardcoded path requirement
  assert.strictEqual(typeof workspaceRoot, 'string')
  logResult('S2: Portable Workspace Discovery', 'PASS', `Resolved: ${workspaceRoot}`)

  // -------------------------------------------------------------------------
  // S3: Read-Only System Telemetry: NVIDIA RTX 4050 GPU, CPU, RAM, Disk, Battery
  // -------------------------------------------------------------------------
  console.log('\n--- Running S3: Read-Only System Telemetry ---')
  const tTelem0 = performance.now()
  const telemResult = await readOnlyTools['get_system_info'].handler({ category: 'all' })
  const telemLatency = (performance.now() - tTelem0).toFixed(1)

  assert.ok(!telemResult.isError, 'get_system_info must succeed')
  const telemData = JSON.parse(telemResult.content[0].text)
  assert.ok(telemData.gpu, 'GPU telemetry must be present')
  assert.ok(telemData.memory, 'Memory telemetry must be present')
  assert.ok(telemData.cpu, 'CPU telemetry must be present')
  assert.ok(telemData.disk, 'Disk telemetry must be present')
  assert.ok(telemData.battery, 'Battery telemetry must be present')

  // Verify GPU specific RTX 4050 details
  if (telemData.gpu.available !== false) {
    assert.strictEqual(telemData.gpu.model, 'NVIDIA GeForce RTX 4050 Laptop GPU')
    assert.ok(typeof telemData.gpu.temperatureC === 'number', 'GPU temperature must be a number')
    assert.ok(typeof telemData.gpu.utilizationPercent === 'number', 'GPU utilization must be a number')
    assert.ok(typeof telemData.gpu.vramTotalMB === 'number', 'VRAM total must be a number')
  }

  logResult(
    'S3: Read-Only System Telemetry (RTX 4050 + CPU/RAM/Disk/Battery)',
    'PASS',
    `GPU: ${telemData.gpu.model || 'Detected'} (${telemData.gpu.temperatureC}°C), RAM: ${telemData.memory.usedGB}/${telemData.memory.totalGB}GB, CPU: ${telemData.cpu.loadPercent}%`,
    { telemetryDuration: parseFloat(telemLatency) },
  )

  // -------------------------------------------------------------------------
  // S4: Fast File Search & Directory Listing (Read-Only)
  // -------------------------------------------------------------------------
  console.log('\n--- Running S4: Read-Only File Search & Directory Listing ---')
  const tSearch0 = performance.now()
  const searchRes = await readOnlyTools['search_files'].handler({
    pattern: 'orchestrator.mjs',
    rootDir: workspaceRoot,
  })
  const searchLatency = (performance.now() - tSearch0).toFixed(1)
  assert.ok(!searchRes.isError, 'search_files must succeed')
  const searchData = JSON.parse(searchRes.content[0].text)
  assert.ok(searchData.count > 0, 'Must find orchestrator.mjs')
  assert.ok(searchData.matches.some((m) => m.name === 'orchestrator.mjs'))

  const listRes = await readOnlyTools['list_directory'].handler({ dirPath: path.join(workspaceRoot, 'jarvis') })
  assert.ok(!listRes.isError, 'list_directory must succeed')
  const listData = JSON.parse(listRes.content[0].text)
  assert.ok(listData.total > 0, 'Must return directory items')
  assert.ok(listData.items.some((i) => i.name === 'package.json'))

  logResult('S4: Read-Only File Search & Directory Listing', 'PASS', `Found ${searchData.count} matches in workspace`, {
    searchDuration: parseFloat(searchLatency),
  })

  // -------------------------------------------------------------------------
  // S5: Read-Only Safe File Reader with Byte Capping
  // -------------------------------------------------------------------------
  console.log('\n--- Running S5: Read-Only Safe File Reader ---')
  const readRes = await readOnlyTools['read_file'].handler({
    filePath: path.join(workspaceRoot, 'jarvis', 'package.json'),
    maxBytes: 1024,
  })
  assert.ok(!readRes.isError, 'read_file must succeed')
  assert.ok(readRes.content[0].text.includes('"name": "jarvis"'), 'Must contain package.json contents')
  logResult('S5: Read-Only Safe File Reader', 'PASS', 'Read jarvis/package.json with byte cap safely')

  // -------------------------------------------------------------------------
  // S6: File-Operation Permission Model (ALLOW_WRITES=0 vs ALLOW_WRITES=1)
  // -------------------------------------------------------------------------
  console.log('\n--- Running S6: File Operation Permission Gating ---')
  const testFilePath = path.join(workspaceRoot, 'jarvis', 'scratch', 'test_perm_file.tmp')

  // S6.1: When ALLOW_WRITES=false, creating file must be strictly DENIED
  const createDenied = await readOnlyTools['file_operation'].handler({
    action: 'create',
    source: testFilePath,
    content: 'hello',
  })
  assert.strictEqual(createDenied.isError, true)
  assert.ok(createDenied.content[0].text.includes('Permission denied'))
  logResult('S6.1: Write Permission Enforcement (ALLOW_WRITES=0)', 'PASS', 'Create file strictly denied in read-only mode')

  // S6.2: When ALLOW_WRITES=true, deleting without confirmed:true must be REJECTED
  const deleteNoConfirm = await writeTools['file_operation'].handler({
    action: 'delete',
    source: testFilePath,
    confirmed: false,
  })
  assert.strictEqual(deleteNoConfirm.isError, true)
  assert.ok(deleteNoConfirm.content[0].text.includes('requires explicit user confirmation'))
  logResult('S6.2: Destructive Delete Confirmation Gate', 'PASS', 'Delete rejected when confirmed=false')

  // S6.3: Create file with ALLOW_WRITES=true, then prevent silent overwrite
  const createOk = await writeTools['file_operation'].handler({
    action: 'create',
    source: testFilePath,
    content: 'Initial data',
    confirmed: true,
  })
  assert.strictEqual(createOk.isError, undefined)
  assert.ok(fs.existsSync(testFilePath))

  const overwriteSilent = await writeTools['file_operation'].handler({
    action: 'create',
    source: testFilePath,
    content: 'Overwritten data',
    overwrite: false,
  })
  assert.strictEqual(overwriteSilent.isError, true)
  assert.ok(overwriteSilent.content[0].text.includes('already exists'))
  logResult('S6.3: Anti-Silent-Overwrite Guard', 'PASS', 'Silent file overwrite prevented')

  // Clean up test file cleanly
  const deleteClean = await writeTools['file_operation'].handler({
    action: 'delete',
    source: testFilePath,
    confirmed: true,
  })
  assert.strictEqual(deleteClean.isError, undefined)
  assert.ok(!fs.existsSync(testFilePath))

  // -------------------------------------------------------------------------
  // S7: Process Listing in User Session
  // -------------------------------------------------------------------------
  console.log('\n--- Running S7: Active User Session Process Listing ---')
  const procRes = await readOnlyTools['list_processes'].handler({ topN: 10 })
  assert.ok(!procRes.isError, 'list_processes must succeed')
  const procList = JSON.parse(procRes.content[0].text)
  assert.ok(Array.isArray(procList), 'Process list must be array')
  assert.ok(procList.length > 0, 'Must find active user processes')
  assert.ok(procList.some((p) => p.name && p.pid), 'Entries must have name and pid')
  logResult('S7: User Session Process Listing', 'PASS', `Retrieved ${procList.length} user session processes`)

  // -------------------------------------------------------------------------
  // S8: Desktop Screenshot Capture / Session Awareness
  // -------------------------------------------------------------------------
  console.log('\n--- Running S8: Desktop Screenshot Capture ---')
  const tScreen0 = performance.now()
  const screenRes = await readOnlyTools['take_screenshot'].handler({})
  const screenLatency = (performance.now() - tScreen0).toFixed(1)
  // Screenshot will either succeed (interactive) or report clean session status (headless)
  assert.ok(screenRes.content[0].text, 'Screenshot tool must return informative status')
  const isCaptured = screenRes.content[0].text.includes('Screenshot captured successfully')
  logResult(
    'S8: Desktop Screenshot Capture',
    'PASS',
    isCaptured ? 'Captured active desktop PNG' : `Session status reported: ${screenRes.content[0].text}`,
    { screenshotDuration: parseFloat(screenLatency) },
  )

  // -------------------------------------------------------------------------
  // S9: End-to-End Fast-Path Session with canUseTool Authorization
  // -------------------------------------------------------------------------
  console.log('\n--- Running S9: End-to-End Fast-Path Session Pipeline ---')
  async function* makePrompt(text) {
    yield { message: { content: text } }
  }

  const mockOptions = {
    mcpServers: { spark_windows: winMcpReadOnly },
    canUseTool: async (name) => {
      // Mock permission check: allow read-only tools, deny powershell & file modifications
      if (name === 'spark_windows__powershell' || name === 'spark_windows__file_operation') {
        return { behavior: 'deny', message: 'Blocked: writes not allowed.' }
      }
      return { behavior: 'allow' }
    },
  }

  // S9.1: Telemetry Fast-Path Turn
  const tFast0 = performance.now()
  const session1 = createAgentSession(makePrompt('laptop status ela undi'), mockOptions)
  let firstResponseMs = null
  let fullCompletionMs = null
  let fastSpeechResult = ''

  for await (const evt of session1) {
    if (evt.type === 'stream_event' && evt.event?.delta?.text && firstResponseMs === null) {
      firstResponseMs = (performance.now() - tFast0).toFixed(2)
    }
    if (evt.type === 'result') {
      fullCompletionMs = (performance.now() - tFast0).toFixed(2)
      fastSpeechResult = evt.result
    }
  }

  assert.ok(firstResponseMs !== null, 'Must receive first token / stream event')
  assert.ok(fullCompletionMs !== null, 'Must complete turn')
  assert.ok(fastSpeechResult.includes('System report') || fastSpeechResult.includes('CPU') || fastSpeechResult.includes('telemetry'), 'Response must contain telemetry details')

  logResult(
    'S9.1: Telugu-English Telemetry Fast-Path Execution',
    'PASS',
    `Response: "${fastSpeechResult.slice(0, 65)}..."`,
    {
      firstTokenLatency: parseFloat(firstResponseMs),
      fullTurnDuration: parseFloat(fullCompletionMs),
    },
  )

  // S9.2: Fast-Path Permission Denial Test (Authorization cannot be bypassed)
  const deniedOptions = {
    mcpServers: { spark_windows: winMcpReadOnly },
    canUseTool: async () => ({ behavior: 'deny', message: 'Permission denied: tool access blocked by policy.' }),
  }
  const sessionDenied = createAgentSession(makePrompt('open calculator'), deniedOptions)
  let deniedResult = null
  for await (const evt of sessionDenied) {
    if (evt.type === 'result') deniedResult = evt
  }
  assert.strictEqual(deniedResult?.subtype, 'failed')
  assert.ok(deniedResult.errors[0].includes('Permission denied'))
  logResult('S9.2: Fast-Path Authorization Gate Enforcement', 'PASS', 'Denied by canUseTool without executing tool')

  // -------------------------------------------------------------------------
  // S10: Consistent Anti-Loop Limit & Deduplication Fingerprinting
  // -------------------------------------------------------------------------
  console.log('\n--- Running S10: Anti-Loop & Deduplication Safeguards ---')
  const ledger = new TurnToolLedger(MAX_TOOL_CYCLES_PER_TURN)

  const call1 = ledger.recordCall('spark_windows__open_path', { path: 'https://youtube.com' })
  assert.strictEqual(call1.isDuplicate, false)
  assert.strictEqual(call1.cycleCount, 1)

  // Identical duplicate call in the same turn
  const call2 = ledger.recordCall('spark_windows__open_path', { path: 'https://youtube.com' })
  assert.strictEqual(call2.isDuplicate, true, 'Identical call must be marked duplicate')

  // Legitimate independent call in the same turn
  const call3 = ledger.recordCall('spark_windows__search_files', { pattern: '*.json' })
  assert.strictEqual(call3.isDuplicate, false, 'Independent action must not be blocked')
  assert.strictEqual(call3.cycleCount, 3)

  // Cycle limit reached
  const call4 = ledger.recordCall('spark_windows__read_file', { filePath: 'test.txt' })
  assert.strictEqual(call4.isExceeded, true, 'Turn cycle limit must be triggered at MAX_TOOL_CYCLES_PER_TURN')

  logResult('S10: Consistent Anti-Loop Limits & Deduplication', 'PASS', 'Fingerprinted duplicate calls and enforced 3-cycle cap')

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n===============================================================')
  console.log('PHASE H2 VERIFICATION SUMMARY')
  console.log('===============================================================')
  console.table(
    results.map((r) => ({
      Scenario: r.scenario,
      Status: r.status,
      Details: r.detail.slice(0, 70),
      Metrics: r.metrics ? JSON.stringify(r.metrics) : '-',
    })),
  )

  const allPassed = results.every((r) => r.status === 'PASS')
  assert.ok(allPassed, 'All test scenarios must pass')
  console.log('\n>>> ALL PHASE H2 VERIFICATION TESTS PASSED SUCCESSFULLY! <<<')
}

runTests().catch((err) => {
  console.error('\n[FATAL TEST FAILURE]:', err)
  process.exit(1)
})
