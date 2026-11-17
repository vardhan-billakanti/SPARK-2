/**
 * SPARK Hybrid Brain Orchestration & Privacy Inspector.
 *
 * Implements:
 *   1. Outbound Data Privacy Inspector (Pre-flight check before EVERY Gemini call)
 *   2. Deterministic Task Classifier (Qwen local-first default, Gemini specialist)
 *   3. Canonical Conversation Ledger & Schema Transformers
 *   4. Exactly-Once Tool Tracking & Deduplication
 */

/**
 * Common sensitive data signatures to block from outbound cloud transmission.
 */
const SENSITIVE_PATTERNS = [
  // Private keys and certificates
  { name: 'Private Key', regex: /-----BEGIN\s+(?:[A-Z\s]+)?PRIVATE\s+KEY-----/i },
  // Google API keys
  { name: 'Google API Key', regex: /\bAIza[0-9A-Za-z-_]{30,40}\b/ },
  // Anthropic API keys
  { name: 'Anthropic API Key', regex: /\bsk-ant-[a-zA-Z0-9_\-]{32,}\b/ },
  // OpenAI API keys
  { name: 'OpenAI API Key', regex: /\bsk-[a-zA-Z0-9]{32,}\b/ },
  // GitHub tokens
  { name: 'GitHub Token', regex: /\b(?:gh[pousr]_[0-9a-zA-Z]{36,}|github_pat_[0-9a-zA-Z_]{22,})\b/ },
  // AWS Access Keys
  { name: 'AWS Access Key', regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/ },
  // Passwords or secrets in key-value form
  { name: 'Password/Secret Assignment', regex: /(?:password|secret|passwd|token|apikey)\s*[:=]\s*["']?([^\s"']{5,})["']?/i },
  // Database connection strings with credentials
  { name: 'Database Connection String with Credentials', regex: /(?:postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|mssql):\/\/[^\s:]+:[^\s@]+@/i },
  // Bearer authentication tokens
  { name: 'Bearer Token', regex: /\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/i },
  // Sensitive files or paths
  { name: 'Private Key / Credential Path', regex: /(?:\.env(?:\.local|\.production)?|\bid_rsa\b|\bid_ed25519\b|\.aws[\\\/]credentials|\.ssh[\\\/])/i },
  // Credit card numbers (Luhn candidate pattern)
  { name: 'Credit Card Pattern', regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/ },
  // US SSN
  { name: 'Social Security Number', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
];

/**
 * Extracts all string fragments from an arbitrary data structure.
 */
function extractAllStrings(target, collected = []) {
  if (target === null || target === undefined) return collected;
  if (typeof target === 'string') {
    collected.push(target);
    return collected;
  }
  if (typeof target === 'number' || typeof target === 'boolean') {
    return collected;
  }
  if (Array.isArray(target)) {
    for (const item of target) {
      extractAllStrings(item, collected);
    }
    return collected;
  }
  if (typeof target === 'object') {
    for (const val of Object.values(target)) {
      extractAllStrings(val, collected);
    }
  }
  return collected;
}

/**
 * Inspects any payload (prompts, conversation history, tool outputs, retrieved files)
 * for sensitive data before transmission to external cloud services.
 *
 * @param {any} payload - String, object, or array to inspect
 * @returns {{ hasSensitiveData: boolean, reasons: string[] }}
 */
export function inspectPrivacyRisk(payload) {
  const strings = extractAllStrings(payload);
  const combined = strings.join('\n');
  const reasons = [];

  for (const { name, regex } of SENSITIVE_PATTERNS) {
    if (regex.test(combined)) {
      reasons.push(name);
    }
  }

  return {
    hasSensitiveData: reasons.length > 0,
    reasons,
  };
}

/**
 * Deterministic Task Classifier.
 * Decides whether a turn should be handled by local Qwen (default) or escalated to Gemini.
 *
 * @param {string} text - User prompt
 * @param {Array} history - Canonical conversation turns
 * @returns {{ provider: 'qwen' | 'gemini', reason: string, isEscalation: boolean }}
 */
export function classifyTurnIntent(text, history = []) {
  if (!text || typeof text !== 'string') {
    return { provider: 'qwen', reason: 'Empty or non-string prompt', isEscalation: false };
  }

  const t = text.trim().toLowerCase();

  // 1. Explicit user override keywords
  if (/\b(?:ask\s+gemini|use\s+gemini|switch\s+to\s+gemini|gemini\s+thoti|escalate\s+to\s+gemini|use\s+cloud)\b/i.test(t)) {
    return { provider: 'gemini', reason: 'Explicit user request for Gemini Cloud', isEscalation: true };
  }
  if (/\b(?:use\s+qwen|switch\s+to\s+qwen|local\s+only|offline\s+only|local\s+model)\b/i.test(t)) {
    return { provider: 'qwen', reason: 'Explicit user request for local Qwen', isEscalation: false };
  }

  // 2. Clear Local Qwen triggers: greetings & casual conversation
  const GREETING_REGEX = /\b(?:hello|hi|hey|good\s+(?:morning|afternoon|evening|day)|greetings|how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do)\b/i;
  if (GREETING_REGEX.test(t) && !/(?:architectural|debug|refactor|design\s+pattern|distributed)/i.test(t)) {
    return { provider: 'qwen', reason: 'Conversational greeting handled locally', isEscalation: false };
  }

  // 3. Telugu conversational phrases & actions
  const TELUGU_CONVERSATIONAL = /\b(?:nuvvu\s+evarivi|ela\s+unnavu|cheppu|em\s+chestunnavu|namaskaram|enti\s+sangathulu|chudu|chupinchu)\b/i;
  if (TELUGU_CONVERSATIONAL.test(t) && !/(?:architectural|debug|refactor|design\s+pattern)/i.test(t)) {
    return { provider: 'qwen', reason: 'Telugu conversational query handled locally', isEscalation: false };
  }

  // 4. Laptop application commands & web shortcuts
  const APP_OR_ACTION = /\b(?:open|launch|start|run|calculator|calc|notepad|chrome|terminal|wt|explorer|youtube|github|google|open\s+cheyyi|start\s+cheyyi)\b/i;
  if (APP_OR_ACTION.test(t) && !/(?:architectural|deep\s+analysis|distributed|cryptanalysis)/i.test(t)) {
    return { provider: 'qwen', reason: 'Everyday desktop/action command handled locally', isEscalation: false };
  }

  // 5. Basic programming queries (palindrome, reverse string, simple functions)
  const SIMPLE_CODE = /^(?:write|generate|give\s+me|create|show\s+me)\s+(?:a\s+|an\s+)?(?:simple\s+|basic\s+)?(?:python|javascript|js|ts|typescript|c\+\+|java|html|css|sql|bash)?\s*(?:function|script|code|palindrome|calculator|fibonacci|factorial|sort|loop)/i;
  if (SIMPLE_CODE.test(t) && !/(?:architecture|concurrency|distributed|profiling|memory\s+leak|deep\s+review)/i.test(t)) {
    return { provider: 'qwen', reason: 'Standard coding query handled locally', isEscalation: false };
  }

  // 6. Gemini Escalation: Complex multi-step reasoning, architectural analysis, distributed systems
  const COMPLEX_REASONING_TRIGGERS = [
    /\b(?:architectural\s+analysis|system\s+architecture|distributed\s+consensus|paxos|raft)\b/i,
    /\b(?:multi-module\s+race\s+condition|memory\s+leak\s+profiling|deadlock\s+detection)\b/i,
    /\b(?:deep\s+architectural\s+review|multi-step\s+planning|complex\s+refactoring\s+plan)\b/i,
    /\b(?:comprehensive\s+threat\s+modeling|cryptographic\s+proof)\b/i,
  ];

  if (COMPLEX_REASONING_TRIGGERS.some((re) => re.test(t))) {
    return { provider: 'gemini', reason: 'Complex architectural/reasoning scenario escalated to Gemini Specialist', isEscalation: true };
  }

  // 7. Default to local Qwen for everything else
  return { provider: 'qwen', reason: 'Default local-first execution', isEscalation: false };
}

/**
 * Normalizes and validates tool arguments for Ollama/Qwen.
 * Ollama requires tool_calls[].function.arguments to be a valid native JSON object (map[string]any).
 *
 * @param {any} rawArgs - Object or JSON string
 * @param {string} toolName - Tool name for error context
 * @returns {object} - Validated native plain object
 * @throws {Error} - If arguments cannot be parsed or are not a non-null plain object
 */
export function normalizeQwenToolArguments(rawArgs, toolName = 'unknown') {
  if (rawArgs === null || rawArgs === undefined) {
    return {};
  }

  let parsed = rawArgs;
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed || trimmed === '{}') return {};
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Malformed JSON in arguments for tool '${toolName}': ${err.message}`);
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Invalid arguments for tool '${toolName}': expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
    );
  }

  return parsed;
}

/**
 * Manages the canonical conversation ledger and provides schema translation
 * to ensure context survives provider switching with exactly-once tool semantics.
 */
export class CanonicalLedger {
  constructor(systemPrompt = '') {
    this.systemPrompt = systemPrompt;
    this.turns = []; // Array of { role, content, provider, toolCalls, toolResults, timestamp }
    this.executedToolIds = new Set();
  }

  addUserMessage(text) {
    this.turns.push({
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });
  }

  addAssistantMessage(content, provider = 'qwen', toolCalls = []) {
    this.turns.push({
      role: 'assistant',
      content: content || '',
      provider,
      toolCalls: toolCalls || [],
      timestamp: Date.now(),
    });
  }

  addToolResult(toolUseId, toolName, output, isError = false) {
    this.executedToolIds.add(toolUseId);
    this.turns.push({
      role: 'tool',
      toolUseId,
      toolName,
      content: output,
      isError,
      timestamp: Date.now(),
    });
  }

  hasExecutedTool(toolUseId) {
    return this.executedToolIds.has(toolUseId);
  }

  /**
   * Converts canonical turns into Qwen (ChatML / OpenAI format).
   * Note: Ollama requires tool_calls[].function.arguments to be a native JSON object, NOT a string.
   */
  toQwenFormat() {
    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }

    for (const turn of this.turns) {
      if (turn.role === 'user') {
        messages.push({ role: 'user', content: turn.content });
      } else if (turn.role === 'assistant') {
        const msg = { role: 'assistant', content: turn.content || '' };
        if (turn.toolCalls && turn.toolCalls.length > 0) {
          msg.tool_calls = turn.toolCalls.map((tc) => {
            let normalizedArgs;
            try {
              normalizedArgs = normalizeQwenToolArguments(tc.args, tc.name);
            } catch (argErr) {
              console.warn(`[spark:ledger] ${argErr.message}`);
              normalizedArgs = { _error: argErr.message };
            }
            return {
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: normalizedArgs,
              },
            };
          });
        }
        messages.push(msg);
      } else if (turn.role === 'tool') {
        messages.push({
          role: 'tool',
          tool_call_id: turn.toolUseId,
          name: turn.toolName,
          content: turn.content,
        });
      }
    }

    return messages;
  }

  /**
   * Converts canonical turns into Gemini (@google/genai format).
   */
  toGeminiFormat() {
    const contents = [];

    for (const turn of this.turns) {
      if (turn.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: turn.content }],
        });
      } else if (turn.role === 'assistant') {
        const parts = [];
        if (turn.content) {
          parts.push({ text: turn.content });
        }
        if (turn.toolCalls && turn.toolCalls.length > 0) {
          for (const tc of turn.toolCalls) {
            let parsedArgs = {};
            try {
              parsedArgs = normalizeQwenToolArguments(tc.args, tc.name);
            } catch {
              parsedArgs = {};
            }
            parts.push({
              functionCall: {
                name: tc.name,
                args: parsedArgs,
              },
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (turn.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: turn.toolName,
                response: { output: turn.content },
              },
            },
          ],
        });
      }
    }

    return contents;
  }
}

/**
 * Maximum tool execution cycles permitted per turn across all providers
 * to prevent runaway loops while accommodating multi-step workflows.
 */
export const MAX_TOOL_CYCLES_PER_TURN = 3;

/**
 * Tracks tool executions and fingerprints within an active turn to prevent infinite loops
 * and duplicate tool-call thrashing while allowing independent tool executions.
 */
export class TurnToolLedger {
  constructor(maxCycles = MAX_TOOL_CYCLES_PER_TURN) {
    this.maxCycles = maxCycles;
    this.cycleCount = 0;
    this.seenFingerprints = new Set();
  }

  recordCall(toolName, args = {}) {
    this.cycleCount++;
    const sortedArgs = JSON.stringify(args || {}, Object.keys(args || {}).sort());
    const fingerprint = `${toolName}::${sortedArgs}`;
    const isDuplicate = this.seenFingerprints.has(fingerprint);
    this.seenFingerprints.add(fingerprint);
    return {
      cycleCount: this.cycleCount,
      isExceeded: this.cycleCount > this.maxCycles,
      isDuplicate,
      fingerprint,
    };
  }

  canContinue() {
    return this.cycleCount < this.maxCycles;
  }
}

/**
 * Common web service URL map for zero-latency URL dispatch.
 */
const COMMON_WEB_SERVICES = {
  youtube: 'https://www.youtube.com',
  github: 'https://github.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  reddit: 'https://www.reddit.com',
  chatgpt: 'https://chatgpt.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  linkedin: 'https://www.linkedin.com',
};

/**
 * Deterministic Fast-Path Action Detector.
 *
 * Intercepts unambiguous desktop control, navigation, telemetry, and app lifecycle
 * commands in English and Telugu-English, executing in < 10ms without LLM overhead
 * while strictly honoring the MCP tool and permission pipeline.
 *
 * @param {string} rawText - User input text
 * @returns {object|null} - Action descriptor or null if turn requires full LLM reasoning
 */
export function detectFastPathAction(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const t = rawText.trim().toLowerCase();

  // Guard: if prompt includes complex reasoning or coding requests, do not fast-path
  if (/(?:write|generate|solve|debug|why|how|compare|summarize)\b/i.test(t) && !/(?:screen|gpu|laptop|system|hardware|status)/i.test(t)) {
    return null;
  }

  // 1. Workspace / Spark Project Folder
  if (
    /(?:open|show|explore)\s+(?:the\s+|my\s+)?(?:spark(?:\s+project)?|project)\s+folder\b/i.test(t) ||
    /(?:spark(?:\s+project)?|project)\s+folder\s+(?:open\s*(?:cheyyi|chey)?|chupinchu)\b/i.test(t)
  ) {
    return {
      type: 'open_workspace',
      toolName: 'spark_windows__open_path',
      args: { path: 'spark_workspace' },
      defaultSpeech: 'Opening the SPARK workspace folder.',
    };
  }

  // 2. Desktop Screenshot
  if (
    /(?:take|capture)\s+(?:a\s+)?(?:screenshot|screen\s+capture|screen\s+photo)\b/i.test(t) ||
    /(?:screenshot|screen\s+photo)\s*(?:teeyi|theeyi|kottu|cheyyi|chey)\b/i.test(t) ||
    t === 'screenshot'
  ) {
    return {
      type: 'take_screenshot',
      toolName: 'spark_windows__take_screenshot',
      args: {},
      defaultSpeech: 'Desktop screenshot captured.',
    };
  }

  // 2b. Desktop Screen Vision & Multimodal Analysis
  if (
    /(?:what(?:'s|\s+is)\s+(?:on|visible\s+on)\s+(?:my\s+)?screen|look\s+at\s+(?:my\s+)?screen|analyze\s+(?:the\s+|my\s+)?screen|what\s+do\s+you\s+see\s+on\s+(?:my\s+)?screen)\b/i.test(t) ||
    /(?:screen\s+lo\s+em\s+undi|screen\s+chudu)\b/i.test(t)
  ) {
    return {
      type: 'analyze_screen',
      toolName: 'spark_vision__analyze_screen',
      args: { query: rawText },
      defaultSpeech: 'Analyzing your desktop screen.',
    };
  }

  // 2c. Persistent Memory Store
  const rememberMatch = t.match(/^(?:remember\s+(?:that\s+)?|gurtupettuko\s+)(.+)/i);
  if (rememberMatch) {
    const factText = rememberMatch[1].trim();
    return {
      type: 'remember_fact',
      toolName: 'spark_memory__remember_fact',
      args: { category: 'notes', key: `note_${Date.now()}`, value: factText },
      defaultSpeech: 'Saved to persistent memory.',
    };
  }

  // 3. System & Hardware Telemetry (GPU, CPU, RAM, Battery, Full System)
  const isTelemetry =
    /(?:check|show|get|display|what\s+is\s+(?:the\s+|my\s+)?)\s*(?:gpu|nvidia|rtx\s*4050|temperature|temp|cpu|ram|memory|battery|system\s+stats|laptop\s+status|hardware\s+status)\b/i.test(t) ||
    /(?:gpu|rtx\s*4050|cpu|ram|memory|battery|laptop|system)\s*(?:status|usage|stats|temp(?:erature)?|ela\s+undi|cheppu|entha\s+undi)\b/i.test(t) ||
    /(?:gpu|nvidia|rtx\s*4050)\s+(?:temperature|temp)\b/i.test(t) ||
    /^(?:system\s+stats|laptop\s+status|hardware\s+status|gpu\s+status|gpu\s+temperature|battery\s+status)$/i.test(t);

  if (isTelemetry) {
    let category = 'all';
    if (/(?:gpu|nvidia|rtx\s*4050|temperature|temp)/i.test(t) && !/(?:cpu|ram|battery|system)/i.test(t)) {
      category = 'gpu';
    } else if (/(?:cpu|ram|memory)/i.test(t) && !/(?:gpu|battery|system)/i.test(t)) {
      category = 'cpu_ram';
    } else if (/battery/i.test(t) && !/(?:gpu|cpu|ram)/i.test(t)) {
      category = 'battery';
    } else if (/(?:disk|storage|drive\s+c)/i.test(t)) {
      category = 'disk';
    }

    return {
      type: 'get_system_info',
      toolName: 'spark_windows__get_system_info',
      args: { category },
      formatSpeech: (output) => {
        try {
          const data = typeof output === 'string' ? JSON.parse(output) : output;
          if (category === 'gpu' && data.gpu) {
            return `NVIDIA RTX 4050 is running at ${data.gpu.temperatureC || 45} degrees Celsius with ${data.gpu.utilizationPercent || 0}% utilization. VRAM used is ${data.gpu.vramUsedMB || 0} MB of ${data.gpu.vramTotalMB || 6144} MB.`;
          }
          if (category === 'cpu_ram' && data.cpu && data.memory) {
            return `CPU load is at ${data.cpu.loadPercent || 0}%. RAM usage is ${data.memory.usedGB || 0} GB out of ${data.memory.totalGB || 16} GB.`;
          }
          if (category === 'battery' && data.battery) {
            return `Battery is at ${data.battery.chargePercent || 100}% and currently ${data.battery.status || 'discharging'}.`;
          }
          return `System report: CPU is at ${data.cpu?.loadPercent || 0}%, RAM is at ${data.memory?.usedGB || 0} GB of ${data.memory?.totalGB || 16} GB, and the RTX 4050 is at ${data.gpu?.temperatureC || 45} degrees Celsius.`;
        } catch {
          return 'System telemetry retrieved successfully.';
        }
      },
    };
  }

  // 4. List Running Processes
  if (
    /(?:list|show|what\s+are)\s+(?:running\s+)?(?:processes|apps|applications)\b/i.test(t) ||
    /(?:running\s+apps|processes)\s*(?:chupinchu|list\s+cheyyi|cheppu)\b/i.test(t)
  ) {
    return {
      type: 'list_processes',
      toolName: 'spark_windows__list_processes',
      args: { topN: 10 },
      formatSpeech: (output) => {
        return 'Here are the active applications currently running on your system.';
      },
    };
  }

  // 5. Close Application
  const closeMatch =
    t.match(/^(?:close|exit|terminate|kill|quit)\s+(?:the\s+)?(calculator|calc|chrome|vs\s*code|vscode|code|antigravity(?:\s+ide)?|task\s*manager|taskmgr|settings|notepad|terminal|wt|whatsapp|explorer|spotify)\b/i) ||
    t.match(/^(calculator|calc|chrome|vs\s*code|vscode|code|antigravity(?:\s+ide)?|task\s*manager|taskmgr|settings|notepad|terminal|wt|whatsapp|explorer|spotify)\s+(?:close\s*cheyyi|close\s*chey|aapeyi|aapu)\b/i);

  if (closeMatch) {
    const rawApp = closeMatch[1].trim().toLowerCase();
    const appMap = {
      calculator: 'calc',
      calc: 'calc',
      chrome: 'chrome',
      'vs code': 'code',
      vscode: 'code',
      code: 'code',
      antigravity: 'antigravity',
      'antigravity ide': 'antigravity',
      'task manager': 'taskmgr',
      taskmgr: 'taskmgr',
      settings: 'settings',
      notepad: 'notepad',
      terminal: 'wt',
      wt: 'wt',
      whatsapp: 'whatsapp',
      explorer: 'explorer',
      spotify: 'spotify',
    };
    const targetApp = appMap[rawApp] || rawApp;
    return {
      type: 'close_app',
      toolName: 'spark_windows__close_app',
      args: { app: targetApp },
      defaultSpeech: `Closed ${rawApp}.`,
    };
  }

  // 6. Spotify & Windows Media Playback Control
  // 6a. Explicit Spotify playback & search
  const spotifyPlayMatch =
    t.match(/^(?:start\s+playing\s+(?:a\s+)?song\s+in\s+spotify|play\s+(?:a\s+)?song\s+in\s+spotify|play\s+spotify)\b/i) ||
    t.match(/^(?:play|start\s+playing)\s+(.+?)\s+(?:in|on)\s+spotify\b/i) ||
    t.match(/^spotify\s+lo\s+(.+?)\s*(?:play|pettu|start)\s*(?:cheyyi|chey)?$/i);

  if (spotifyPlayMatch) {
    const rawQuery = spotifyPlayMatch[1] ? spotifyPlayMatch[1].trim() : 'Top Hits';
    const cleanQuery = rawQuery.replace(/^(?:a\s+)?song(?:\s+in\s+spotify)?$/i, '').trim() || 'Top Hits';
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'play_spotify', query: cleanQuery },
      defaultSpeech: `Playing ${cleanQuery} on Spotify.`,
    };
  }

  // 6b. Generic media controls (pause, resume, skip, volume)
  if (/\b(?:pause|aapu|aapeyi)\s*(?:the\s+)?(?:music|song|track|playback|spotify|video)?\b/i.test(t) || t === 'pause') {
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'pause' },
      defaultSpeech: 'Paused playback.',
    };
  }
  if (/\b(?:resume|unpause|continue)\s*(?:the\s+)?(?:music|song|track|playback|spotify|video)?\b/i.test(t) || t === 'resume') {
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'resume' },
      defaultSpeech: 'Resumed playback.',
    };
  }
  if (/\b(?:next\s+(?:song|track)|skip\s+(?:this\s+)?(?:song|track)|skip)\b/i.test(t) || /(?:song|track)\s+(?:marchu|next)\b/i.test(t)) {
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'next' },
      defaultSpeech: 'Skipped to next track.',
    };
  }
  if (/\b(?:previous\s+(?:song|track)|prev\s+(?:song|track)|go\s+back)\b/i.test(t)) {
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'previous' },
      defaultSpeech: 'Returned to previous track.',
    };
  }
  if (/\b(?:volume\s+up|increase\s+volume|louder)\b/i.test(t) || /sound\s+penchu\b/i.test(t)) {
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'volume_up' },
      defaultSpeech: 'Volume increased.',
    };
  }
  if (/\b(?:volume\s+down|decrease\s+volume|lower\s+volume|quieter)\b/i.test(t) || /sound\s+tagginchu\b/i.test(t)) {
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'volume_down' },
      defaultSpeech: 'Volume decreased.',
    };
  }
  if (/\b(?:mute|unmute|sound\s+aapu)\b/i.test(t)) {
    return {
      type: 'media_control',
      toolName: 'spark_windows__media_control',
      args: { action: 'mute' },
      defaultSpeech: 'Mute toggled.',
    };
  }

  // 7. YouTube Search & Playback (Direct foreground video / song playback)
  const ytPlayMatch =
    t.match(/^(?:open\s+(?:yt|youtube)\s+and\s+(?:start\s+)?play(?:ing)?|search\s+(?:yt|youtube)\s+for|play\s+on\s+(?:yt|youtube))\s+(.+)/i) ||
    t.match(/^(?:play)\s+(?:a\s+|the\s+)?(.+)/i) ||
    t.match(/^(?:youtube|yt)\s+lo\s+(.+?)\s*(?:play|search|pettu|start)\s*(?:cheyyi|chey)?$/i);

  if (ytPlayMatch) {
    const query = ytPlayMatch[1].trim().replace(/^(?:song|track|music|video)\s+/i, '');
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    return {
      type: 'play_media',
      toolName: 'spark_windows__open_path',
      args: { path: searchUrl },
      defaultSpeech: `Playing ${query} on YouTube.`,
    };
  }

  // 7. Web Service / URL Navigation (open youtube, github, google, etc.)
  const webMatch =
    t.match(/^(?:open|launch|navigate\s+to|go\s+to)\s+(?:the\s+)?(youtube|yt|github|google|gmail|reddit|chatgpt|twitter|linkedin)\b/i) ||
    t.match(/^(youtube|yt|github|google|gmail|reddit|chatgpt|twitter|linkedin)\s+(?:open|pettu|start)\s*(?:cheyyi|chey|ceyyi)?\b/i);

  if (webMatch) {
    let siteKey = webMatch[1].trim().toLowerCase();
    if (siteKey === 'yt') siteKey = 'youtube';
    const targetUrl = COMMON_WEB_SERVICES[siteKey] || `https://www.${siteKey}.com`;
    return {
      type: 'open_url',
      toolName: 'spark_windows__open_path',
      args: { path: targetUrl },
      defaultSpeech: `Opening ${siteKey.charAt(0).toUpperCase() + siteKey.slice(1)}.`,
    };
  }

  // Explicit URL match (e.g. "open https://example.com" or "https://example.com open chey")
  const directUrlMatch = t.match(/^(?:open|go\s+to|navigate\s+to)\s+(https?:\/\/[^\s]+)/i) || t.match(/^(https?:\/\/[^\s]+)\s*(?:open\s*(?:cheyyi|chey)?)?$/i);
  if (directUrlMatch) {
    const targetUrl = directUrlMatch[1];
    return {
      type: 'open_url',
      toolName: 'spark_windows__open_path',
      args: { path: targetUrl },
      defaultSpeech: `Opening ${targetUrl}.`,
    };
  }

  // 8. Desktop Application Launch (English and Telugu-English)
  const appLaunchMatch =
    t.match(/^(?:open|launch|start|run)\s+(?:the\s+)?(calculator|calc|chrome|vs\s*code|vscode|code|antigravity(?:\s+ide)?|task\s*manager|taskmgr|settings|notepad|terminal|wt|whatsapp|explorer|spotify)\b/i) ||
    t.match(/^(calculator|calc|chrome|vs\s*code|vscode|code|antigravity(?:\s+ide)?|task\s*manager|taskmgr|settings|notepad|terminal|wt|whatsapp|explorer|spotify)\s+(?:open|start|launch|run)\s*(?:cheyyi|chey|pettu|ceyyi)?\b/i);

  if (appLaunchMatch) {
    const rawApp = appLaunchMatch[1].trim().toLowerCase();
    const appMap = {
      calculator: 'calc',
      calc: 'calc',
      chrome: 'chrome',
      'vs code': 'code',
      vscode: 'code',
      code: 'code',
      antigravity: 'antigravity',
      'antigravity ide': 'antigravity',
      'task manager': 'taskmgr',
      taskmgr: 'taskmgr',
      settings: 'settings',
      notepad: 'notepad',
      terminal: 'wt',
      wt: 'wt',
      whatsapp: 'whatsapp',
      explorer: 'explorer',
      spotify: 'spotify',
    };
    const targetApp = appMap[rawApp] || rawApp;
    const displayName = rawApp === 'calc' ? 'Calculator' : (rawApp.charAt(0).toUpperCase() + rawApp.slice(1));
    return {
      type: 'launch_app',
      toolName: 'spark_windows__launch_app',
      args: { app: targetApp },
      defaultSpeech: `Opening ${displayName}.`,
    };
  }

  return null;
}

