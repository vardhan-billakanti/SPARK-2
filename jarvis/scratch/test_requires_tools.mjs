function requiresTools(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim().toLowerCase();

  // Clear pure greetings & chit-chat
  const GREETING_REGEX = /^(hello|hi|hey|good\s+(morning|afternoon|evening|day)|greetings|how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do|spark|hello\s+spark|hi\s+spark|hey\s+spark)[.!?\s]*$/i;
  if (GREETING_REGEX.test(t)) return false;

  // Pure coding requests without file/IDE action
  const PURE_CODING_REGEX = /^(write|generate|create|give\s+me|show\s+me|implement|solve|explain|code)\s+(a\s+|an\s+)?(simple\s+|basic\s+)?(python|javascript|typescript|js|ts|c\+\+|java|c#|rust|go|html|css|sql|bash|regex|function|algorithm|class|script|program|code|solution)/i;
  const EXPLICIT_FILE_OR_APP = /(notepad|vscode|code\b|terminal|file|folder|directory|save|disk|desktop|calc|browser|chrome)/i;
  if (PURE_CODING_REGEX.test(t) && !EXPLICIT_FILE_OR_APP.test(t)) {
    return false;
  }

  // Pure conceptual questions
  const PURE_QUESTION_REGEX = /^(what|why|how|when|where|who|explain|define|tell\s+me\s+about|can\s+you\s+explain)\s+/i;
  if (PURE_QUESTION_REGEX.test(t) && !EXPLICIT_FILE_OR_APP.test(t) && !/(open|launch|run|navigate|search|check\s+system)/i.test(t)) {
    return false;
  }

  // Explicit action triggers
  const ACTION_TRIGGERS = [
    // English actions
    /\b(open|launch|start|run|execute|browse|navigate|visit|go\s+to|search\s+for|look\s+at|take\s+a\s+screenshot|capture|screenshot)\b/i,
    // Telugu / mixed actions
    /\b(open\s+cheyyi|open\s+chey|start\s+cheyyi|run\s+cheyyi|chudu|chupinchu|teeyi|pettu)\b/i,
    // Direct app names as commands
    /\b(calculator|calc|chrome|notepad|terminal|wt|explorer)\b/i,
    // Specific websites with action intent
    /\b(youtube|google|github)\b/i,
  ];

  return ACTION_TRIGGERS.some((re) => re.test(t));
}

const tests = [
  { input: 'Hello Spark', expected: false },
  { input: 'Write a Python palindrome function.', expected: false },
  { input: 'Open Calculator', expected: true },
  { input: 'Open YouTube', expected: true },
  { input: 'YouTube open cheyyi', expected: true },
  { input: 'What is a palindrome?', expected: false },
  { input: 'Write a function to sort a list', expected: false },
  { input: 'Open Notepad and paste this', expected: true },
  { input: 'Calculator', expected: true },
  { input: 'hi', expected: false }
];

let allPassed = true;
for (const test of tests) {
  const result = requiresTools(test.input);
  const pass = result === test.expected;
  if (!pass) allPassed = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}: "${test.input}" -> requiresTools = ${result} (expected ${test.expected})`);
}

if (allPassed) {
  console.log('\nALL TESTS PASSED!');
} else {
  console.log('\nSOME TESTS FAILED!');
  process.exit(1);
}
