/**
 * SPARK Provider Abstraction & Agent Runner.
 *
 * Provides a unified agent execution interface supporting:
 *   1. Google Gemini API (Primary / Default: @google/genai)
 *   2. Claude Agent SDK (Optional: @anthropic-ai/claude-agent-sdk query)
 *   3. OpenAI-Compatible Providers (DeepSeek, Groq, Ollama, OpenRouter)
 *
 * This allows SPARK to operate with zero code changes in the frontend or tool layer,
 * seamlessly scaling between Google Gemini Flash, free local models, and Claude.
 */

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import { GoogleGenAI } from '@google/genai'
import {
  inspectPrivacyRisk,
  classifyTurnIntent,
  CanonicalLedger,
  detectFastPathAction,
  TurnToolLedger,
  MAX_TOOL_CYCLES_PER_TURN,
} from './orchestrator.mjs'

// Load environment variables if available
for (const envPath of ['.env.local', '.env', 'jarvis/.env.local', 'jarvis/.env', '../.env.local', '../.env']) {
  try {
    process.loadEnvFile?.(envPath)
  } catch {}
}

/** Convert Zod schema to Gemini parameter schema */
function zodToGeminiSchema(zodSchema) {
  if (!zodSchema || !zodSchema.shape) {
    return { type: 'OBJECT', properties: {} }
  }
  const properties = {}
  const required = []

  for (const [key, field] of Object.entries(zodSchema.shape)) {
    let type = 'STRING'
    const desc = field.description || field.def?.description || ''
    const typeName = field._def?.typeName || field.type || field.def?.type

    if (typeName === 'ZodNumber' || typeName === 'number') type = 'NUMBER'
    else if (typeName === 'ZodBoolean' || typeName === 'boolean') type = 'BOOLEAN'
    else if (typeName === 'ZodArray' || typeName === 'array') {
      properties[key] = {
        type: 'ARRAY',
        description: desc,
        items: { type: 'STRING' },
      }
      const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional')
      if (!isOpt) required.push(key)
      continue
    } else if (typeName === 'ZodEnum' || typeName === 'enum') {
      properties[key] = {
        type: 'STRING',
        enum: field._def?.values || field.def?.values,
        description: desc,
      }
      const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional')
      if (!isOpt) required.push(key)
      continue
    }

    properties[key] = { type, description: desc }
    const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional')
    if (!isOpt) {
      required.push(key)
    }
  }

  return {
    type: 'OBJECT',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** Convert Zod schema to OpenAI parameter schema */
function zodToOpenAiSchema(zodSchema) {
  if (!zodSchema || !zodSchema.shape) {
    return { type: 'object', properties: {} }
  }
  const properties = {}
  const required = []

  for (const [key, field] of Object.entries(zodSchema.shape)) {
    let type = 'string'
    const desc = field.description || field.def?.description || ''
    const typeName = field._def?.typeName || field.type || field.def?.type

    if (typeName === 'ZodNumber' || typeName === 'number') type = 'number'
    else if (typeName === 'ZodBoolean' || typeName === 'boolean') type = 'boolean'
    else if (typeName === 'ZodArray' || typeName === 'array') type = 'array'
    else if (typeName === 'ZodEnum' || typeName === 'enum') {
      properties[key] = { type: 'string', enum: field._def?.values || field.def?.values, description: desc }
      const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional')
      if (!isOpt) required.push(key)
      continue
    }

    properties[key] = { type, description: desc }
    const isOpt = typeof field.isOptional === 'function' ? field.isOptional() : (field.type === 'optional' || field.def?.type === 'optional')
    if (!isOpt) {
      required.push(key)
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** Extract tool definitions and function declarations for Google Gemini */
function extractGeminiTools(mcpServers) {
  const toolMap = new Map()
  const functionDeclarations = []

  for (const [serverKey, server] of Object.entries(mcpServers || {})) {
    const regTools = server?.instance?._registeredTools
    if (!regTools) continue

    for (const [toolName, toolDef] of Object.entries(regTools)) {
      // Clean function name: spark_*__<tool> for spark tools, mcp__<server>__<tool> for MCP
      const isSpark = serverKey.startsWith('spark_')
      const primaryName = isSpark
        ? `${serverKey}__${toolName}`
        : `mcp__${serverKey}__${toolName}`

      toolMap.set(primaryName, toolDef)
      // Also register aliases so lookups never fail
      toolMap.set(`mcp__${serverKey}__${toolName}`, toolDef)
      toolMap.set(`${serverKey}__${toolName}`, toolDef)

      functionDeclarations.push({
        name: primaryName,
        description: toolDef.description || '',
        parameters: zodToGeminiSchema(toolDef.inputSchema),
      })
    }
  }

  return { toolMap, functionDeclarations }
}

/** Extract tool definitions and executable handlers from in-process MCP servers */
function extractTools(mcpServers) {
  const toolMap = new Map()
  const openAiTools = []

  for (const [serverKey, server] of Object.entries(mcpServers || {})) {
    const regTools = server?.instance?._registeredTools
    if (!regTools) continue

    for (const [toolName, toolDef] of Object.entries(regTools)) {
      const fullToolName = `mcp__${serverKey}__${toolName}`
      toolMap.set(fullToolName, toolDef)

      openAiTools.push({
        type: 'function',
        function: {
          name: fullToolName,
          description: toolDef.description || '',
          parameters: zodToOpenAiSchema(toolDef.inputSchema),
        },
      })
    }
  }

  return { toolMap, openAiTools }
}

/** Determine if an error from Gemini is a rate-limit / quota exhaustion (HTTP 429) */
function isRateLimitError(err) {
  if (!err) return false
  if (err.status === 429 || err.code === 429 || err.status === 'RESOURCE_EXHAUSTED') return true
  if (err.error?.code === 429 || err.error?.status === 'RESOURCE_EXHAUSTED') return true
  const msg = typeof err === 'string' ? err : String(err?.message || '')
  return (
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Quota exceeded') ||
    msg.includes('rate-limit') ||
    msg.includes('rate limit') ||
    msg.includes('Too Many Requests')
  )
}

/**
 * Google Gemini streaming Agent Runner (Primary).
 * Implements the exact async generator interface that bridge/server.mjs expects.
 */
function createGeminiSession(promptIterable, options) {
  const apiKey = process.env.GEMINI_API_KEY || ''
  // Recommended default: fast, agentic, capable Flash model
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash'

  const { toolMap, functionDeclarations } = extractGeminiTools(options.mcpServers)

  const geminiConfig = {
    systemInstruction: options.systemPrompt || 'You are SPARK, an advanced desktop AI assistant for Windows.',
    ...(functionDeclarations.length > 0
      ? {
          tools: [{ functionDeclarations }],
        }
      : {}),
  }

  let abortController = new AbortController()
  let isClosed = false

  const contents = []

  let ai = null
  if (apiKey) {
    try {
      ai = new GoogleGenAI({ apiKey })
    } catch (err) {
      console.error('[spark:gemini] Client initialization error:', err)
    }
  }

  async function* run() {
    // Notify client of connected server instances
    const usableServers = Object.keys(options.mcpServers || {})
    yield {
      type: 'system',
      subtype: 'init',
      mcp_servers: usableServers.map((s) => ({ name: s, status: 'connected' })),
    }

    for await (const userMsg of promptIterable) {
      if (isClosed) break
      if (!userMsg?.message?.content) continue

      const userText = userMsg.message.content
      contents.push({ role: 'user', parts: [{ text: userText }] })

      // Check API Key
      if (!apiKey || !ai) {
        console.warn('[spark:gemini] Request received but GEMINI_API_KEY is missing.')
        yield {
          type: 'result',
          subtype: 'failed',
          errors: [
            'Missing GEMINI_API_KEY. Please set your GEMINI_API_KEY in the environment or .env file.',
          ],
        }
        continue
      }

      let turnFinished = false
      let turnTokens = ''
      let turnLoops = 0
      const MAX_TURN_LOOPS = 8

      while (!turnFinished && !isClosed && turnLoops < MAX_TURN_LOOPS) {
        turnLoops++
        abortController = new AbortController()

        // Outbound Privacy Check before every Gemini request
        const outboundPrivacy = inspectPrivacyRisk(contents)
        if (outboundPrivacy.hasSensitiveData) {
          console.warn(`[spark:privacy] Outbound Gemini payload blocked: ${outboundPrivacy.reasons.join(', ')}`)
          yield {
            type: 'result',
            subtype: 'failed',
            errors: [
              `Outbound transmission to Google Gemini blocked: sensitive data detected (${outboundPrivacy.reasons.join(', ')}). Aborting cloud transmission for privacy.`,
            ],
          }
          break
        }

        let responseStream
        try {
          responseStream = await ai.models.generateContentStream({
            model,
            contents,
            config: geminiConfig,
          })
        } catch (callErr) {
          let cleanMsg = String(callErr?.message || callErr)
          if (apiKey) cleanMsg = cleanMsg.replaceAll(apiKey, '[REDACTED]')
          console.error('[spark:gemini] API request error:', cleanMsg)
          const isRateLimit = isRateLimitError(callErr)
          yield {
            type: 'result',
            subtype: 'failed',
            errors: [
              isRateLimit
                ? 'Gemini is temporarily rate-limited. Please try again shortly.'
                : `Gemini API error: ${cleanMsg.slice(0, 400)}`,
            ],
          }
          break
        }

        let stepText = ''
        const pendingCalls = []
        const stepParts = []

        try {
          for await (const chunk of responseStream) {
            if (abortController.signal.aborted) {
              break
            }

            // Capture raw parts from candidates to preserve thoughtSignature
            for (const cand of chunk.candidates || []) {
              for (const part of cand.content?.parts || []) {
                stepParts.push(part)
              }
            }

            // Text deltas
            if (chunk.text) {
              stepText += chunk.text
              turnTokens += chunk.text
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: chunk.text },
                },
              }
            }

            // Function call requests from Gemini
            if (chunk.functionCalls && chunk.functionCalls.length > 0) {
              for (const fc of chunk.functionCalls) {
                pendingCalls.push(fc)
              }
            }
          }
        } catch (streamErr) {
          if (abortController.signal.aborted) {
            yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
            return
          }
          let cleanStreamErr = String(streamErr?.message || streamErr)
          if (apiKey) cleanStreamErr = cleanStreamErr.replaceAll(apiKey, '[REDACTED]')
          console.error('[spark:gemini] Stream read error:', cleanStreamErr)
          const isRateLimit = isRateLimitError(streamErr)
          yield {
            type: 'result',
            subtype: 'failed',
            errors: [
              isRateLimit
                ? 'Gemini is temporarily rate-limited. Please try again shortly.'
                : `Stream error: ${cleanStreamErr.slice(0, 400)}`,
            ],
          }
          break
        }

        if (abortController.signal.aborted) {
          yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
          return
        }

        // Handle tool executions
        if (pendingCalls.length > 0) {
          const modelParts = stepParts.length > 0 ? stepParts : (stepText ? [{ text: stepText }] : [])
          if (modelParts.length === 0) {
            for (const fc of pendingCalls) {
              modelParts.push({
                functionCall: {
                  name: fc.name,
                  args: fc.args || {},
                },
              })
            }
          }
          contents.push({ role: 'model', parts: modelParts })

          const functionResponseParts = []

          for (let i = 0; i < pendingCalls.length; i++) {
            const call = pendingCalls[i]
            const callId = call.id || `call_${Date.now()}_${i}`

            // Announce tool execution on HUD/UI
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                content_block: { type: 'tool_use', id: callId, name: call.name },
              },
            }

            // Permission check: passes through options.canUseTool (which enforces decideTool!)
            const perm = await options.canUseTool?.(call.name)
            let toolOutputText = ''
            let isError = false

            if (perm && perm.behavior === 'deny') {
              toolOutputText = perm.message || 'Permission denied: tool execution not permitted in read-only mode.'
              isError = true
            } else {
              const toolDef = toolMap.get(call.name)
              if (!toolDef) {
                toolOutputText = `Tool '${call.name}' not found.`
                isError = true
              } else {
                try {
                  const result = await toolDef.handler(call.args || {})
                  toolOutputText =
                    result?.content?.[0]?.text ||
                    (typeof result === 'string' ? result : JSON.stringify(result))
                } catch (execErr) {
                  toolOutputText = `Tool execution error: ${execErr?.message || execErr}`
                  isError = true
                }
              }
            }

            // Settle tool on bridge / UI
            yield {
              type: 'user',
              message: {
                content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError }],
              },
            }

            // Outbound Privacy Check on tool output before sending to Gemini
            const toolPrivacy = inspectPrivacyRisk(toolOutputText)
            if (toolPrivacy.hasSensitiveData) {
              console.warn(`[spark:privacy] Tool result contains sensitive data: ${toolPrivacy.reasons.join(', ')}`)
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: {
                    type: 'text_delta',
                    text: `\n[Privacy Gate: Sensitive data detected in tool output (${toolPrivacy.reasons.join(', ')}). Subsequent cloud transmission halted for privacy.]\n`,
                  },
                },
              }
              yield {
                type: 'result',
                subtype: 'success',
                result: turnTokens,
              }
              turnFinished = true
              break
            }

            functionResponseParts.push({
              functionResponse: {
                name: call.name,
                response: {
                  output: toolOutputText,
                },
              },
            })
          }

          contents.push({
            role: 'user',
            parts: functionResponseParts,
          })
        } else {
          // No more tool calls: turn finished
          const finalParts = stepParts.length > 0 ? stepParts : (stepText ? [{ text: stepText }] : [])
          if (finalParts.length > 0) {
            contents.push({ role: 'model', parts: finalParts })
          }
          turnFinished = true
          yield {
            type: 'result',
            subtype: 'success',
            result: turnTokens,
            total_cost_usd: 0.00001,
          }
        }
      }
    }
  }

  const session = run()
  session.interrupt = () => {
    abortController.abort()
  }
  session.close = () => {
    isClosed = true
    abortController.abort()
  }

  return session
}

/**
 * OpenAI-compatible streaming Agent Runner (Fallback/Alternative).
 * Implements the exact async generator interface that bridge/server.mjs expects.
 */
function createOpenAiCompatibleSession(promptIterable, options) {
  const provider = (process.env.SPARK_AI_PROVIDER || 'openai_compatible').toLowerCase()

  const baseUrl = (
    process.env.OPENAI_BASE_URL ||
    process.env.SPARK_API_BASE_URL ||
    (provider === 'deepseek'
      ? 'https://api.deepseek.com/v1'
      : provider === 'groq'
      ? 'https://api.groq.com/openai/v1'
      : provider === 'ollama'
      ? 'http://localhost:11434/v1'
      : 'https://api.openai.com/v1')
  ).replace(/\/+$/, '')

  const apiKey =
    process.env.SPARK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.GROQ_API_KEY ||
    ''

  const model =
    process.env.SPARK_MODEL ||
    process.env.OPENAI_MODEL ||
    (provider === 'deepseek'
      ? 'deepseek-chat'
      : provider === 'groq'
      ? 'llama-3.3-70b-versatile'
      : provider === 'ollama'
      ? 'llama3.2'
      : 'gpt-4o-mini')

  const { toolMap, openAiTools } = extractTools(options.mcpServers)

  let abortController = new AbortController()
  let isClosed = false

  const conversation = [{ role: 'system', content: options.systemPrompt || '' }]

  async function* run() {
    // Notify client of active servers
    const usableServers = Object.keys(options.mcpServers || {})
    yield {
      type: 'system',
      subtype: 'init',
      mcp_servers: usableServers.map((s) => ({ name: s, status: 'connected' })),
    }

    // Process user turns
    for await (const userMsg of promptIterable) {
      if (isClosed) break
      if (!userMsg?.message?.content) continue

      const userText = userMsg.message.content
      conversation.push({ role: 'user', content: userText })

      let turnFinished = false
      let turnTokens = ''
      let turnLoops = 0
      const MAX_TURN_LOOPS = 8

      while (!turnFinished && !isClosed && turnLoops < MAX_TURN_LOOPS) {
        turnLoops++
        abortController = new AbortController()

        const requestBody = {
          model,
          messages: conversation,
          stream: true,
          ...(openAiTools.length > 0 ? { tools: openAiTools, tool_choice: 'auto' } : {}),
        }

        let res
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
          })
        } catch (err) {
          if (abortController.signal.aborted) {
            yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
            return
          }
          yield { type: 'result', subtype: 'failed', errors: [String(err)] }
          return
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          yield {
            type: 'result',
            subtype: 'failed',
            errors: [`API request failed (${res.status}): ${errText.slice(0, 500)}`],
          }
          return
        }

        // SSE streaming loop
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let stepContent = ''
        const pendingToolCalls = new Map()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed.startsWith(':')) continue
              if (trimmed === 'data: [DONE]') continue

              if (trimmed.startsWith('data: ')) {
                const rawJson = trimmed.slice(6)
                let chunk
                try {
                  chunk = JSON.parse(rawJson)
                } catch {
                  continue
                }

                const choice = chunk.choices?.[0]
                const delta = choice?.delta
                if (!delta) continue

                // Handle text streaming
                if (delta.content) {
                  stepContent += delta.content
                  turnTokens += delta.content
                  yield {
                    type: 'stream_event',
                    event: {
                      type: 'content_block_delta',
                      delta: { type: 'text_delta', text: delta.content },
                    },
                  }
                }

                // Handle tool calls streaming
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0
                    if (!pendingToolCalls.has(idx)) {
                      pendingToolCalls.set(idx, {
                        id: tc.id || `call_${Date.now()}_${idx}`,
                        name: tc.function?.name || '',
                        arguments: '',
                      })
                    }
                    const existing = pendingToolCalls.get(idx)
                    if (tc.id) existing.id = tc.id
                    if (tc.function?.name) existing.name += tc.function.name
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments
                  }
                }
              }
            }
          }
        } catch (readErr) {
          if (abortController.signal.aborted) {
            yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted'] }
            return
          }
        }

        // If tools were called
        if (pendingToolCalls.size > 0) {
          const toolCallArray = Array.from(pendingToolCalls.values())
          conversation.push({
            role: 'assistant',
            content: stepContent || null,
            tool_calls: toolCallArray.map((t) => ({
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: t.arguments },
            })),
          })

          for (const tc of toolCallArray) {
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                content_block: { type: 'tool_use', id: tc.id, name: tc.name },
              },
            }

            // Check permissions
            const perm = await options.canUseTool?.(tc.name)
            let toolOutputText = ''
            let isError = false

            if (perm && perm.behavior === 'deny') {
              toolOutputText = perm.message || 'Permission denied for this tool.'
              isError = true
            } else {
              const toolDef = toolMap.get(tc.name)
              if (!toolDef) {
                toolOutputText = `Tool not found: ${tc.name}`
                isError = true
              } else {
                try {
                  let parsedArgs = {}
                  if (tc.arguments && tc.arguments.trim()) {
                    parsedArgs = JSON.parse(tc.arguments)
                  }
                  const result = await toolDef.handler(parsedArgs)
                  toolOutputText =
                    result?.content?.[0]?.text ||
                    (typeof result === 'string' ? result : JSON.stringify(result))
                } catch (toolExecErr) {
                  toolOutputText = `Tool execution error: ${toolExecErr.message}`
                  isError = true
                }
              }
            }

            // Yield tool result event
            yield {
              type: 'user',
              message: {
                content: [{ type: 'tool_result', tool_use_id: tc.id, is_error: isError }],
              },
            }

            conversation.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolOutputText,
            })
          }
        } else {
          // No tools called, turn completed
          conversation.push({ role: 'assistant', content: stepContent })
          turnFinished = true
          yield {
            type: 'result',
            subtype: 'success',
            result: turnTokens,
            total_cost_usd: 0.0001,
          }
        }
      }
    }
  }

  const session = run()
  session.interrupt = () => {
    abortController.abort()
  }
  session.close = () => {
    isClosed = true
    abortController.abort()
  }

  return session
}

/**
 * Extract tool definitions and function declarations for Ollama / Qwen.
 */
function extractQwenTools(mcpServers) {
  const toolMap = new Map()
  const tools = []

  for (const [serverKey, server] of Object.entries(mcpServers || {})) {
    const regTools = server?.instance?._registeredTools
    if (!regTools) continue

    for (const [toolName, toolDef] of Object.entries(regTools)) {
      const isSpark = serverKey.startsWith('spark_')
      const primaryName = isSpark
        ? `${serverKey}__${toolName}`
        : `mcp__${serverKey}__${toolName}`

      toolMap.set(primaryName, toolDef)
      toolMap.set(`mcp__${serverKey}__${toolName}`, toolDef)
      toolMap.set(`${serverKey}__${toolName}`, toolDef)

      tools.push({
        type: 'function',
        function: {
          name: primaryName,
          description: toolDef.description || '',
          parameters: zodToOpenAiSchema(toolDef.inputSchema),
        },
      })
    }
  }

  return { toolMap, tools }
}

/**
 * Determines whether a user turn explicitly requires external tool access.
 * Enforces:
 *   - Normal conversation / greetings -> no tools
 *   - Conceptual questions -> no tools
 *   - Coding requests -> direct answer unless explicit file/IDE action requested
 *   - External action requests (open, launch, run, navigate, etc.) -> tools enabled
 */
function requiresTools(text) {
  if (!text || typeof text !== 'string') return false
  const t = text.trim().toLowerCase()

  // Clear pure greetings & pleasantries
  const GREETING_REGEX = /^(hello|hi|hey|good\s+(morning|afternoon|evening|day)|greetings|how\s+are\s+you|who\s+are\s+you|what\s+can\s+you\s+do|spark|hello\s+spark|hi\s+spark|hey\s+spark)[.!?\s]*$/i
  if (GREETING_REGEX.test(t)) return false

  // Pure coding requests without file/IDE action
  const PURE_CODING_REGEX = /^(write|generate|create|give\s+me|show\s+me|implement|solve|explain|code)\s+(a\s+|an\s+)?(simple\s+|basic\s+)?(python|javascript|typescript|js|ts|c\+\+|java|c#|rust|go|html|css|sql|bash|regex|function|algorithm|class|script|program|code|solution)/i
  const EXPLICIT_FILE_OR_APP = /(notepad|vscode|code\b|terminal|file|folder|directory|save|disk|desktop|calc|browser|chrome)/i
  if (PURE_CODING_REGEX.test(t) && !EXPLICIT_FILE_OR_APP.test(t)) {
    return false
  }

  // Pure conceptual questions
  const PURE_QUESTION_REGEX = /^(what|why|how|when|where|who|explain|define|tell\s+me\s+about|can\s+you\s+explain)\s+/i
  if (PURE_QUESTION_REGEX.test(t) && !EXPLICIT_FILE_OR_APP.test(t) && !/(open|launch|run|navigate|search|check\s+system)/i.test(t)) {
    return false
  }

  // Explicit action triggers
  const ACTION_TRIGGERS = [
    // English actions
    /\b(open|launch|start|run|execute|browse|navigate|visit|go\s+to|search\s+for|look\s+at|take\s+a\s+screenshot|capture|screenshot)\b/i,
    // Desktop control, vision, memory, messaging, tasks
    /\b(click|double\s*click|right\s*click|type|press|hotkey|shortcut|mouse|screen|remember|recall|forget|memory|task|todo|send\s+message|whatsapp|email|mail|spotify|volume|mute)\b/i,
    // Telugu / mixed actions
    /\b(open\s+cheyyi|open\s+chey|start\s+cheyyi|run\s+cheyyi|chudu|chupinchu|teeyi|pettu|marchu|penchu|tagginchu|cheppu)\b/i,
    // Direct app names as commands
    /\b(calculator|calc|chrome|notepad|terminal|wt|explorer|spotify)\b/i,
    // Specific websites with action intent
    /\b(youtube|google|github)\b/i,
  ]

  return ACTION_TRIGGERS.some((re) => re.test(t))
}

/**
 * Local Qwen3.5 Agent Runner (Ollama).
 * Streams responses and executes tools locally.
 */
function createQwenSession(promptIterable, options) {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '')
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:3b'
  const think = process.env.QWEN_THINK === '1' ? true : false

  const { toolMap, tools } = extractQwenTools(options.mcpServers)

  let abortController = new AbortController()
  let isClosed = false

  const defaultQwenPrompt = [
    'You are SPARK, an advanced desktop AI assistant for Windows.',
    '',
    'CRITICAL RULES FOR TOOL CALLING:',
    '1. CONVERSATION & GREETINGS: For greetings ("hello", "hi", "how are you"), chit-chat, or introductions, reply directly with friendly text. NEVER invoke any tool.',
    '2. CODING & QUESTIONS: Provide code snippets, explanations, and answers directly in text. NEVER launch an application or editor (like Notepad or VS Code) for a coding question unless the user explicitly commands "open notepad", "open in vscode", or "save to file".',
    '3. TOOL INVOCATION: ONLY invoke tools when the user\'s command explicitly requests an external action (such as "Open Calculator", "Open YouTube", "Launch Chrome", "YouTube open cheyyi").',
    '4. ACCURACY: Never claim an action was performed unless the tool actually executed.',
    '5. MULTILINGUAL: Understand Telugu and Telugu-English mixed commands (e.g. "YouTube open cheyyi" means open YouTube in the browser). Always respond in clear English.',
    '',
    'Keep your spoken responses natural, direct, and concise.'
  ].join('\n')

  const conversation = [{ role: 'system', content: defaultQwenPrompt }]

  async function* run() {
    // Notify client of connected server instances
    const usableServers = Object.keys(options.mcpServers || {})
    yield {
      type: 'system',
      subtype: 'init',
      mcp_servers: usableServers.map((s) => ({ name: s, status: 'connected' })),
    }

    for await (const userMsg of promptIterable) {
      if (isClosed) break
      if (!userMsg?.message?.content) continue

      const userText = userMsg.message.content
      conversation.push({ role: 'user', content: userText })

      // Tool selection safety gate: only pass tools if turn explicitly requires them
      const allowTools = requiresTools(userText)

      let turnFinished = false
      let turnTokens = ''
      let turnLoops = 0
      const MAX_TURN_LOOPS = 8

      while (!turnFinished && !isClosed && turnLoops < MAX_TURN_LOOPS) {
        turnLoops++
        abortController = new AbortController()

        const requestBody = {
          model,
          messages: conversation,
          stream: true,
          think,
          options: {
            num_predict: 350,
            temperature: 0.7,
          },
          ...(allowTools && tools.length > 0 ? { tools } : {}),
        }

        let res
        try {
          res = await fetch(`${host}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
          })
        } catch (err) {
          if (abortController.signal.aborted) {
            yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
            return
          }
          console.error('[spark:qwen] Ollama connection error:', err?.message || err)
          yield {
            type: 'result',
            subtype: 'failed',
            errors: ['Local Qwen is unavailable. Please make sure Ollama is running.'],
          }
          return
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          console.error(`[spark:qwen] Ollama API error (${res.status}):`, errText)
          yield {
            type: 'result',
            subtype: 'failed',
            errors: [`Ollama request failed (${res.status}): ${errText.slice(0, 300)}`],
          }
          return
        }

        // Stream reader for NDJSON lines
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let stepContent = ''
        const pendingCalls = []

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue

              let chunk
              try {
                chunk = JSON.parse(trimmed)
              } catch {
                continue
              }

              const msg = chunk.message
              if (msg?.content) {
                stepContent += msg.content
                turnTokens += msg.content
                yield {
                  type: 'stream_event',
                  event: {
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: msg.content },
                  },
                }
              }

              if (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                  pendingCalls.push(tc)
                }
              }
            }
          }
        } catch (streamErr) {
          if (abortController.signal.aborted) {
            yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
            return
          }
          console.error('[spark:qwen] Stream error:', streamErr?.message || streamErr)
          yield {
            type: 'result',
            subtype: 'failed',
            errors: [`Stream error: ${streamErr.message}`],
          }
          return
        }

        if (abortController.signal.aborted) {
          yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
          return
        }

        // Process tool calls if any were returned
        if (pendingCalls.length > 0) {
          conversation.push({
            role: 'assistant',
            content: stepContent || '',
            tool_calls: pendingCalls,
          })

          for (let i = 0; i < pendingCalls.length; i++) {
            const tc = pendingCalls[i]
            const callId = tc.id || `call_${Date.now()}_${i}`
            const funcName = tc.function?.name || ''
            let funcArgs = {}
            if (typeof tc.function?.arguments === 'string') {
              try {
                funcArgs = JSON.parse(tc.function.arguments)
              } catch {
                funcArgs = {}
              }
            } else if (typeof tc.function?.arguments === 'object' && tc.function.arguments !== null) {
              funcArgs = tc.function.arguments
            }

            // Announce tool execution on Spark UI
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_start',
                content_block: { type: 'tool_use', id: callId, name: funcName },
              },
            }

            // Permission check: passes through options.canUseTool (which enforces decideTool!)
            const perm = await options.canUseTool?.(funcName)
            let toolOutputText = ''
            let isError = false

            if (perm && perm.behavior === 'deny') {
              toolOutputText = perm.message || 'Permission denied: tool execution not permitted in read-only mode.'
              isError = true
            } else {
              const toolDef = toolMap.get(funcName)
              if (!toolDef) {
                toolOutputText = `Tool '${funcName}' not found.`
                isError = true
              } else {
                try {
                  const result = await toolDef.handler(funcArgs)
                  toolOutputText =
                    result?.content?.[0]?.text ||
                    (typeof result === 'string' ? result : JSON.stringify(result))
                } catch (execErr) {
                  toolOutputText = `Tool execution error: ${execErr?.message || execErr}`
                  isError = true
                }
              }
            }

            // Settle tool on bridge / UI
            yield {
              type: 'user',
              message: {
                content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError }],
              },
            }

            conversation.push({
              role: 'tool',
              name: funcName,
              tool_call_id: callId,
              content: toolOutputText,
            })
          }
        } else {
          // No tools called, turn completed
          conversation.push({ role: 'assistant', content: stepContent })
          turnFinished = true
          yield {
            type: 'result',
            subtype: 'success',
            result: turnTokens,
            total_cost_usd: 0,
          }
        }
      }
    }
  }

  const session = run()
  session.interrupt = () => {
    abortController.abort()
  }
  session.close = () => {
    isClosed = true
    abortController.abort()
  }

  return session
}

/**
 * SPARK Hybrid Agent Session.
 *
 * Implements intelligent, privacy-preserving hybrid orchestration:
 *   - Local-first: Qwen 2.5 3B (Ollama on NVIDIA RTX 4050 GPU) is the default provider.
 *   - Specialist Cloud: Google Gemini Flash (@google/genai) escalates complex reasoning.
 *   - Outbound Privacy Inspector: inspects prompts, context, and tool outputs before EVERY Gemini call.
 *   - Zero-Spend Fallback: If Ollama is offline, prompts user for approval before using cloud Gemini.
 *   - Rate-Limit Resilience: Automatically continues with local Qwen if Gemini is rate-limited.
 *   - Exactly-Once Tool Execution: Canonical ledger prevents any duplicate tool runs across provider shifts.
 */
function createHybridSession(promptIterable, options) {
  const ollamaHost = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '')
  const qwenModel = process.env.OLLAMA_MODEL || 'qwen2.5:3b'
  const think = process.env.QWEN_THINK === '1'
  const geminiApiKey = process.env.GEMINI_API_KEY || ''
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash'

  let ai = null
  if (geminiApiKey) {
    try {
      ai = new GoogleGenAI({ apiKey: geminiApiKey })
    } catch (err) {
      console.error('[spark:hybrid] Gemini client init error:', err)
    }
  }

  const { toolMap: qwenToolMap, tools: qwenTools } = extractQwenTools(options.mcpServers)
  const { toolMap: geminiToolMap, functionDeclarations } = extractGeminiTools(options.mcpServers)

  const geminiConfig = {
    systemInstruction: options.systemPrompt || 'You are SPARK, an advanced desktop AI assistant for Windows.',
    ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
  }

  const canonicalLedger = new CanonicalLedger(options.systemPrompt || '')
  let abortController = new AbortController()
  let isClosed = false
  let pendingCloudApprovalTask = null // Holds user prompt waiting for explicit approval if Ollama was offline

  async function* run() {
    // 1. Announce connected MCP servers to the client
    const usableServers = Object.keys(options.mcpServers || {})
    yield {
      type: 'system',
      subtype: 'init',
      mcp_servers: usableServers.map((s) => ({ name: s, status: 'connected' })),
    }

    for await (const userMsg of promptIterable) {
      if (isClosed) break
      if (!userMsg?.message?.content) continue

      const rawUserText = userMsg.message.content
      console.log(`[spark:hybrid] Turn received: "${rawUserText.slice(0, 60)}"`)

      let targetProvider = null
      let activeTextToRun = rawUserText

      // Check for user approval of a previous offline cloud fallback offer
      if (pendingCloudApprovalTask) {
        if (/^(?:yes|y|proceed|approve|use\s+gemini|use\s+cloud|cloud\s+use\s+chey|sure|ok)[.!?\s]*$/i.test(rawUserText.trim())) {
          console.log('[spark:hybrid] User approved Gemini cloud fallback for pending task.')
          targetProvider = 'gemini'
          activeTextToRun = pendingCloudApprovalTask
          pendingCloudApprovalTask = null
        } else {
          pendingCloudApprovalTask = null
        }
      }

      canonicalLedger.addUserMessage(activeTextToRun)

      // 1. Ultra-Fast Deterministic Fast-Path Engine (Bypasses LLM inference, strictly checks permissions)
      const fastPathAction = detectFastPathAction(activeTextToRun)
      if (fastPathAction) {
        console.log(`[spark:hybrid:fastpath] Deterministic action matched: ${fastPathAction.type} -> ${fastPathAction.toolName}`)
        const callId = `fast_${Date.now()}`
        const fullToolName = fastPathAction.toolName

        // Security check via existing authorization pipeline (Correction 1)
        const perm = await options.canUseTool?.(fullToolName)
        if (perm && perm.behavior === 'deny') {
          console.warn(`[spark:hybrid:fastpath] Tool ${fullToolName} denied by permission gate.`)
          const denialText = perm.message || 'Permission denied: tool execution not permitted in read-only mode.'
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: denialText },
            },
          }
          canonicalLedger.addAssistantMessage(denialText, 'fastpath')
          yield {
            type: 'result',
            subtype: 'failed',
            errors: [denialText],
          }
          continue
        }

        // Look up registered tool handler
        const toolDef = qwenToolMap.get(fullToolName) || geminiToolMap.get(fullToolName)
        if (!toolDef) {
          console.warn(`[spark:hybrid:fastpath] Tool ${fullToolName} handler not found. Falling back to LLM inference.`)
        } else {
          // Announce tool execution
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: { type: 'tool_use', id: callId, name: fullToolName },
            },
          }

          let toolOutputText = ''
          let isError = false
          try {
            const result = await toolDef.handler(fastPathAction.args || {})
            toolOutputText = result?.content?.[0]?.text || (typeof result === 'string' ? result : JSON.stringify(result))
            isError = Boolean(result?.isError)
          } catch (execErr) {
            toolOutputText = `Tool execution error: ${execErr?.message || execErr}`
            isError = true
          }

          // Announce tool result
          yield {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError }] },
          }

          // Preserve context in Canonical Ledger
          canonicalLedger.addAssistantMessage('', 'fastpath', [{ id: callId, name: fullToolName, args: fastPathAction.args }])
          canonicalLedger.addToolResult(callId, fullToolName, toolOutputText, isError)

          // Formulate conversational response
          let spokenText = ''
          if (isError) {
            spokenText = `I ran into an issue: ${toolOutputText}`
          } else if (typeof fastPathAction.formatSpeech === 'function') {
            spokenText = fastPathAction.formatSpeech(toolOutputText)
          } else if (toolOutputText && /already open/i.test(toolOutputText)) {
            spokenText = toolOutputText
          } else if (fastPathAction.defaultSpeech) {
            spokenText = fastPathAction.defaultSpeech
          } else if (toolOutputText && !toolOutputText.startsWith('{') && !toolOutputText.startsWith('[')) {
            spokenText = toolOutputText
          } else {
            spokenText = 'Done.'
          }

          canonicalLedger.addAssistantMessage(spokenText, 'fastpath')

          // Stream response delta
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: spokenText },
            },
          }

          yield {
            type: 'result',
            subtype: 'success',
            result: spokenText,
            total_cost_usd: 0,
          }
          continue
        }
      }

      // Classify intent if target provider wasn't explicitly set by approval
      if (!targetProvider) {
        const intent = classifyTurnIntent(activeTextToRun, canonicalLedger.turns)
        targetProvider = intent.provider
        console.log(`[spark:hybrid] Intent classified -> ${targetProvider} (Reason: ${intent.reason})`)
      }

      // Pre-flight outbound privacy check before any Gemini routing
      if (targetProvider === 'gemini') {
        const geminiCandidatePayload = canonicalLedger.toGeminiFormat()
        const privacy = inspectPrivacyRisk(geminiCandidatePayload)
        if (privacy.hasSensitiveData) {
          console.warn(`[spark:hybrid] Outbound cloud payload blocked by Privacy Gate: ${privacy.reasons.join(', ')}`)
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: {
                type: 'text_delta',
                text: `[Privacy Gate: Sensitive data (${privacy.reasons.join(', ')}) detected. Outbound cloud transmission blocked. Processing locally on Qwen.]\n`,
              },
            },
          }
          targetProvider = 'qwen'
        }
      }

      // Check Ollama connectivity if target is Qwen
      let qwenIsOffline = false
      if (targetProvider === 'qwen') {
        try {
          const pingRes = await fetch(`${ollamaHost}/api/tags`, {
            signal: AbortSignal.timeout(1500),
          })
          if (!pingRes.ok) qwenIsOffline = true
        } catch {
          qwenIsOffline = true
        }

        if (qwenIsOffline) {
          console.warn('[spark:hybrid] Qwen (Ollama) is offline. Requesting user approval before cloud fallback.')
          pendingCloudApprovalTask = activeTextToRun
          const offlineNotice = "Local Qwen is currently offline. Would you like to use Google Gemini Cloud instead? Please reply 'yes' or 'use cloud' to proceed."
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: offlineNotice },
            },
          }
          yield {
            type: 'result',
            subtype: 'success',
            result: offlineNotice,
          }
          continue
        }
      }

      // Execute turn
      let turnDone = false
      let turnTokens = ''
      let turnLoops = 0
      let turnResultYielded = false
      const MAX_TURN_LOOPS = MAX_TOOL_CYCLES_PER_TURN || 3

      if (targetProvider === 'qwen') {
        const conversation = canonicalLedger.toQwenFormat()
        const allowTools = requiresTools(activeTextToRun)
        const turnLedger = new TurnToolLedger(MAX_TURN_LOOPS)

        while (!turnDone && !isClosed && turnLoops < MAX_TURN_LOOPS) {
          turnLoops++
          abortController = new AbortController()

          const requestBody = {
            model: qwenModel,
            messages: conversation,
            stream: true,
            think,
            options: { num_predict: 350, temperature: 0.7 },
            ...(allowTools && qwenTools.length > 0 ? { tools: qwenTools } : {}),
          }

          let res
          try {
            res = await fetch(`${ollamaHost}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody),
              signal: abortController.signal,
            })
          } catch (err) {
            if (abortController.signal.aborted) {
              yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
              return
            }
            console.error('[spark:hybrid:qwen] Fetch error:', err?.message || err)
            const connectionError = 'Unable to connect to local Ollama on http://localhost:11434. Please ensure Ollama is running.'
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: connectionError },
              },
            }
            canonicalLedger.addAssistantMessage(connectionError, 'qwen')
            yield {
              type: 'result',
              subtype: 'failed',
              errors: ['Local Qwen request failed. Please check Ollama.'],
            }
            turnDone = true
            break
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => '')
            console.error(`[spark:hybrid:qwen] API error (${res.status}):`, errText)
            const readableError = `Local Qwen encountered an error (HTTP ${res.status}): ${errText.slice(0, 150)}`
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: readableError },
              },
            }
            canonicalLedger.addAssistantMessage(readableError, 'qwen')
            yield {
              type: 'result',
              subtype: 'failed',
              errors: [`Ollama request failed (${res.status}): ${errText.slice(0, 300)}`],
            }
            turnDone = true
            break
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let stepContent = ''
          const pendingCalls = []

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed) continue
                let chunk
                try { chunk = JSON.parse(trimmed) } catch { continue }

                const msg = chunk.message
                if (msg?.content) {
                  // Filter out accidental accessibility tag dump (e.g. svgsvg canvas)
                  if (/^(?:svg\s*)+canvas\s*$/i.test(msg.content.trim())) {
                    continue
                  }
                  stepContent += msg.content
                  turnTokens += msg.content
                  yield {
                    type: 'stream_event',
                    event: {
                      type: 'content_block_delta',
                      delta: { type: 'text_delta', text: msg.content },
                    },
                  }
                }
                if (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                  for (const tc of msg.tool_calls) pendingCalls.push(tc)
                }
              }
            }
          } catch (streamErr) {
            if (abortController.signal.aborted) {
              yield { type: 'result', subtype: 'interrupted', errors: ['Interrupted by user'] }
              return
            }
            console.error('[spark:hybrid:qwen] Stream error:', streamErr?.message || streamErr)
            yield { type: 'result', subtype: 'failed', errors: [`Stream error: ${streamErr.message}`] }
            turnDone = true
            break
          }

          if (pendingCalls.length > 0) {
            conversation.push({ role: 'assistant', content: stepContent || '', tool_calls: pendingCalls })
            canonicalLedger.addAssistantMessage(stepContent, 'qwen', pendingCalls.map((tc) => ({
              id: tc.id,
              name: tc.function?.name,
              args: tc.function?.arguments,
            })))

            for (let i = 0; i < pendingCalls.length; i++) {
              const tc = pendingCalls[i]
              const callId = tc.id || `call_${Date.now()}_${i}`
              const funcName = tc.function?.name || ''

              // Exactly-once check
              if (canonicalLedger.hasExecutedTool(callId)) {
                console.log(`[spark:hybrid:tool] Skipping already executed tool call: ${callId}`)
                continue
              }

              let funcArgs = {}
              let argError = null
              if (typeof tc.function?.arguments === 'string') {
                const trimmed = tc.function.arguments.trim()
                if (trimmed && trimmed !== '{}') {
                  try {
                    funcArgs = JSON.parse(trimmed)
                  } catch (parseErr) {
                    argError = `Malformed JSON in tool arguments: ${parseErr.message}`
                  }
                }
              } else if (typeof tc.function?.arguments === 'object' && tc.function.arguments !== null && !Array.isArray(tc.function.arguments)) {
                funcArgs = tc.function.arguments
                if (funcArgs._error) {
                  argError = funcArgs._error
                }
              } else if (tc.function?.arguments !== null && tc.function?.arguments !== undefined) {
                argError = `Invalid arguments for tool '${funcName}': expected a JSON object, got ${Array.isArray(tc.function.arguments) ? 'array' : typeof tc.function.arguments}`
              }

              // Anti-loop duplicate tool-call check (Correction 5)
              const callRecord = turnLedger.recordCall(funcName, funcArgs)
              if (callRecord.isDuplicate) {
                console.log(`[spark:hybrid:tool] Blocked duplicate tool call in same turn: ${callRecord.fingerprint}`)
                const dupNotice = `[Duplicate tool execution skipped: identical tool and arguments already executed this turn]`
                conversation.push({ role: 'tool', name: funcName, tool_call_id: callId, content: dupNotice })
                canonicalLedger.addToolResult(callId, funcName, dupNotice, false)
                continue
              }
              if (callRecord.isExceeded) {
                console.warn(`[spark:hybrid:tool] Tool cycle limit (${MAX_TURN_LOOPS}) reached for this turn. Halting tool loop.`)
                turnDone = true
                break
              }

              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', id: callId, name: funcName },
                },
              }

              const perm = await options.canUseTool?.(funcName)
              let toolOutputText = ''
              let isError = false

              if (perm && perm.behavior === 'deny') {
                toolOutputText = perm.message || 'Permission denied: tool execution not permitted in read-only mode.'
                isError = true
              } else if (argError) {
                toolOutputText = `Tool call rejected: ${argError}`
                isError = true
              } else {
                const toolDef = qwenToolMap.get(funcName)
                if (!toolDef) {
                  toolOutputText = `Tool '${funcName}' not found.`
                  isError = true
                } else {
                  try {
                    const result = await toolDef.handler(funcArgs)
                    toolOutputText = result?.content?.[0]?.text || (typeof result === 'string' ? result : JSON.stringify(result))
                  } catch (execErr) {
                    toolOutputText = `Tool execution error: ${execErr?.message || execErr}`
                    isError = true
                  }
                }
              }

              yield {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError }] },
              }

              conversation.push({ role: 'tool', name: funcName, tool_call_id: callId, content: toolOutputText })
              canonicalLedger.addToolResult(callId, funcName, toolOutputText, isError)

              // Prevent automatic DOM scraping loop if command was a direct navigation
              if (funcName.includes('chrome_navigate') || funcName.includes('open_path')) {
                if (!/(?:read|find|search|inspect|text|content|what\s+is\s+on)\b/i.test(activeTextToRun)) {
                  turnDone = true
                }
              }
            }
          } else {
            canonicalLedger.addAssistantMessage(stepContent, 'qwen')
            turnDone = true
            turnResultYielded = true
            yield {
              type: 'result',
              subtype: 'success',
              result: turnTokens,
              total_cost_usd: 0,
            }
          }
        }

        // Guarantee that a completed Qwen turn always yields a result event to prevent infinite THINKING
        if (!turnResultYielded && !isClosed) {
          const finalResultText = turnTokens || 'Done.'
          canonicalLedger.addAssistantMessage(finalResultText, 'qwen')
          yield {
            type: 'result',
            subtype: 'success',
            result: finalResultText,
            total_cost_usd: 0,
          }
        }
      } else if (targetProvider === 'gemini') {
        if (!geminiApiKey || !ai) {
          console.warn('[spark:hybrid] Gemini chosen but GEMINI_API_KEY missing. Falling back to local Qwen.')
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: '[GEMINI_API_KEY missing. Continuing locally on Qwen...]\n' },
            },
          }
          // Fall back to Qwen
          targetProvider = 'qwen'
          continue
        }

        let geminiContents = canonicalLedger.toGeminiFormat()
        let fallbackToQwen = false
        const turnLedger = new TurnToolLedger(MAX_TURN_LOOPS)

        while (!turnDone && !isClosed && turnLoops < MAX_TURN_LOOPS) {
          turnLoops++
          abortController = new AbortController()

          // Pre-flight Outbound Privacy Check before every generateContentStream call
          const outboundCheck = inspectPrivacyRisk(geminiContents)
          if (outboundCheck.hasSensitiveData) {
            console.warn(`[spark:hybrid:gemini] Privacy Gate blocked outbound call: ${outboundCheck.reasons.join(', ')}`)
            yield {
              type: 'stream_event',
              event: {
                type: 'content_block_delta',
                delta: {
                  type: 'text_delta',
                  text: `\n[Privacy Gate: Sensitive data (${outboundCheck.reasons.join(', ')}) detected. Halting cloud transmission. Continuing locally on Qwen...]\n`,
                },
              },
            }
            fallbackToQwen = true
            break
          }

          let responseStream
          try {
            responseStream = await ai.models.generateContentStream({
              model: geminiModel,
              contents: geminiContents,
              config: geminiConfig,
            })
          } catch (callErr) {
            const isRateLimit = isRateLimitError(callErr)
            if (isRateLimit) {
              console.warn('[spark:hybrid:gemini] Gemini rate-limited. Falling back to local Qwen.')
              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: '\n[Gemini rate-limited. Falling back to local Qwen on RTX 4050 GPU...]\n' },
                },
              }
              fallbackToQwen = true
              break
            } else {
              let cleanMsg = String(callErr?.message || callErr)
              if (geminiApiKey) cleanMsg = cleanMsg.replaceAll(geminiApiKey, '[REDACTED]')
              console.error('[spark:hybrid:gemini] API call error:', cleanMsg)
              yield {
                type: 'result',
                subtype: 'failed',
                errors: [`Gemini API error: ${cleanMsg.slice(0, 300)}`],
              }
              turnDone = true
              break
            }
          }

          let stepText = ''
          const stepFunctionCalls = []

          try {
            for await (const chunk of responseStream) {
              if (chunk.text) {
                stepText += chunk.text
                turnTokens += chunk.text
                yield {
                  type: 'stream_event',
                  event: {
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: chunk.text },
                  },
                }
              }
              if (chunk.functionCalls && chunk.functionCalls.length > 0) {
                for (const fc of chunk.functionCalls) stepFunctionCalls.push(fc)
              }
            }
          } catch (streamErr) {
            console.error('[spark:hybrid:gemini] Stream read error:', streamErr?.message || streamErr)
            yield { type: 'result', subtype: 'failed', errors: [`Stream error: ${streamErr.message}`] }
            turnDone = true
            break
          }

          if (stepFunctionCalls.length > 0) {
            const functionResponseParts = []
            canonicalLedger.addAssistantMessage(stepText, 'gemini', stepFunctionCalls.map((fc, i) => ({
              id: `gemini_call_${Date.now()}_${i}`,
              name: fc.name,
              args: fc.args,
            })))

            let toolPrivacyBlocked = false
            for (let i = 0; i < stepFunctionCalls.length; i++) {
              const call = stepFunctionCalls[i]
              const callId = `gemini_call_${Date.now()}_${i}`

              if (canonicalLedger.hasExecutedTool(callId)) continue

              // Anti-loop duplicate tool-call check (Correction 5)
              const record = turnLedger.recordCall(call.name, call.args || {})
              if (record.isDuplicate) {
                console.log(`[spark:hybrid:gemini] Blocked duplicate identical tool call in turn: ${record.fingerprint}`)
                const dupNotice = `[Duplicate tool execution skipped: identical tool and arguments already executed this turn]`
                functionResponseParts.push({
                  functionResponse: { name: call.name, response: { output: dupNotice } },
                })
                canonicalLedger.addToolResult(callId, call.name, dupNotice, false)
                continue
              }
              if (record.isExceeded) {
                console.warn(`[spark:hybrid:gemini] Tool cycle limit (${MAX_TURN_LOOPS}) reached for this turn. Halting tool loop.`)
                turnDone = true
                break
              }

              yield {
                type: 'stream_event',
                event: {
                  type: 'content_block_start',
                  content_block: { type: 'tool_use', id: callId, name: call.name },
                },
              }

              const perm = await options.canUseTool?.(call.name)
              let toolOutputText = ''
              let isError = false

              if (perm && perm.behavior === 'deny') {
                toolOutputText = perm.message || 'Permission denied: tool execution not permitted in read-only mode.'
                isError = true
              } else {
                const toolDef = geminiToolMap.get(call.name)
                if (!toolDef) {
                  toolOutputText = `Tool '${call.name}' not found.`
                  isError = true
                } else {
                  try {
                    const result = await toolDef.handler(call.args || {})
                    toolOutputText = result?.content?.[0]?.text || (typeof result === 'string' ? result : JSON.stringify(result))
                  } catch (execErr) {
                    toolOutputText = `Tool execution error: ${execErr?.message || execErr}`
                    isError = true
                  }
                }
              }

              // Privacy check on tool output before returning to Gemini
              const toolPrivacy = inspectPrivacyRisk(toolOutputText)
              if (toolPrivacy.hasSensitiveData) {
                console.warn(`[spark:hybrid:privacy] Tool result contains sensitive data: ${toolPrivacy.reasons.join(', ')}`)
                yield {
                  type: 'stream_event',
                  event: {
                    type: 'content_block_delta',
                    delta: {
                      type: 'text_delta',
                      text: `\n[Privacy Gate: Sensitive data (${toolPrivacy.reasons.join(', ')}) detected in tool result. Halting subsequent cloud call.]\n`,
                    },
                  },
                }
                toolPrivacyBlocked = true
              }

              yield {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError }] },
              }

              canonicalLedger.addToolResult(callId, call.name, toolOutputText, isError)

              // Prevent automatic DOM scraping loop if command was a direct navigation
              if (call.name.includes('chrome_navigate') || call.name.includes('open_path')) {
                if (!/(?:read|find|search|inspect|text|content|what\s+is\s+on)\b/i.test(activeTextToRun)) {
                  turnDone = true
                }
              }

              functionResponseParts.push({
                functionResponse: {
                  name: call.name,
                  response: { output: toolOutputText },
                },
              })
            }

            if (toolPrivacyBlocked) {
              turnDone = true
              yield {
                type: 'result',
                subtype: 'success',
                result: turnTokens,
              }
              break
            }

            geminiContents = canonicalLedger.toGeminiFormat()
          } else {
            canonicalLedger.addAssistantMessage(stepText, 'gemini')
            turnDone = true
            turnResultYielded = true
            yield {
              type: 'result',
              subtype: 'success',
              result: turnTokens,
            }
          }
        }

        // Guarantee that a completed Gemini turn always yields a result event
        if (!turnResultYielded && !isClosed && !fallbackToQwen) {
          const finalResultText = turnTokens || 'Done.'
          canonicalLedger.addAssistantMessage(finalResultText, 'gemini')
          yield {
            type: 'result',
            subtype: 'success',
            result: finalResultText,
            total_cost_usd: 0,
          }
        }

        if (fallbackToQwen) {
          // Fall back gracefully to local Qwen for this turn
          const conversation = canonicalLedger.toQwenFormat()
          const allowTools = requiresTools(activeTextToRun)
          const requestBody = {
            model: qwenModel,
            messages: conversation,
            stream: true,
            think,
            options: { num_predict: 350, temperature: 0.7 },
            ...(allowTools && qwenTools.length > 0 ? { tools: qwenTools } : {}),
          }
          try {
            const fallbackRes = await fetch(`${ollamaHost}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody),
            })
            if (fallbackRes.ok) {
              const reader = fallbackRes.body.getReader()
              const decoder = new TextDecoder()
              let buf = ''
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                buf += decoder.decode(value, { stream: true })
                const lines = buf.split('\n')
                buf = lines.pop() || ''
                for (const l of lines) {
                  if (!l.trim()) continue
                  try {
                    const chunk = JSON.parse(l)
                    if (chunk.message?.content) {
                      yield {
                        type: 'stream_event',
                        event: {
                          type: 'content_block_delta',
                          delta: { type: 'text_delta', text: chunk.message.content },
                        },
                      }
                    }
                  } catch {}
                }
              }
              yield { type: 'result', subtype: 'success', result: turnTokens }
            }
          } catch (fbErr) {
            console.error('[spark:hybrid:fallback] Qwen fallback failed:', fbErr)
          }
        }
      }
    }
  }

  const session = run()
  session.interrupt = () => abortController.abort()
  session.close = () => { isClosed = true; abortController.abort() }
  return session
}

/**
 * Main factory function for creating an Agent Session.
 * Automatically chooses between Hybrid (default), Qwen, Gemini, Claude Agent SDK, and OpenAI-Compatible runner.
 */
export function createAgentSession(promptIterable, options) {
  const provider = (process.env.SPARK_AI_PROVIDER || 'hybrid').toLowerCase()

  if (provider === 'hybrid') {
    return createHybridSession(promptIterable, options)
  }

  if (provider === 'qwen') {
    return createQwenSession(promptIterable, options)
  }

  if (provider === 'claude') {
    return claudeQuery({ prompt: promptIterable, options })
  }

  if (provider === 'gemini') {
    return createGeminiSession(promptIterable, options)
  }

  return createOpenAiCompatibleSession(promptIterable, options)
}

