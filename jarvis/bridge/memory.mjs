/**
 * SPARK Persistent Memory Engine.
 *
 * Provides long-term memory storage across sessions:
 *   - user_preferences (voice, language, custom settings)
 *   - facts (hardware, software, system configuration)
 *   - project_context (active repositories, directories, endpoints)
 *   - notes (user-defined reminders and notes)
 *
 * Adheres strictly to the SPARK Action Verification Framework:
 * All tools return { status: 'COMPLETED' | 'UNVERIFIED' | 'FAILED' | 'NEEDS_APPROVAL', verificationDetails: string }
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { getSparkWorkspaceRoot } from './windows.mjs'

function getMemoryStorePath() {
  const root = getSparkWorkspaceRoot()
  const memDir = path.join(root, 'jarvis', 'memory')
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true })
  }
  return path.join(memDir, 'store.json')
}

export function readMemoryStore() {
  const storePath = getMemoryStorePath()
  try {
    if (!fs.existsSync(storePath)) {
      const initial = {
        user_preferences: {
          honorific: 'none',
          do_not_call: 'sir',
          voice_tone: 'sweet_female',
        },
        facts: {
          assistant_name: 'SPARK',
          gpu_model: 'NVIDIA GeForce RTX 4050 Laptop GPU',
        },
        project_context: {
          project_name: 'SPARK 2',
        },
        notes: {},
        session_history: [],
      }
      fs.writeFileSync(storePath, JSON.stringify(initial, null, 2), 'utf8')
      return initial
    }
    const raw = fs.readFileSync(storePath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    console.error('[spark:memory] Failed to read store:', err)
    return { user_preferences: {}, facts: {}, project_context: {}, notes: {}, session_history: [] }
  }
}

export function writeMemoryStore(data) {
  const storePath = getMemoryStorePath()
  try {
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch (err) {
    console.error('[spark:memory] Failed to write store:', err)
    return false
  }
}

export function memoryServer({ allowWrites = true } = {}) {
  return createSdkMcpServer({
    name: 'spark_memory',
    version: '1.0.0',
    tools: [
      // 1. REMEMBER FACT / PREFERENCE
      tool(
        'remember_fact',
        'Store a persistent fact, preference, or project note into SPARK long-term memory.',
        {
          category: z.enum(['user_preferences', 'facts', 'project_context', 'notes']).describe('Category of memory to store.'),
          key: z.string().describe('Key or label for this memory.'),
          value: z.string().describe('The value or detail to remember.'),
        },
        async ({ category, key, value }) => {
          try {
            const store = readMemoryStore()
            if (!store[category]) store[category] = {}
            store[category][key] = value

            const ok = writeMemoryStore(store)
            if (!ok) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'FAILED',
                      verificationDetails: 'Could not write to disk storage.',
                      category,
                      key,
                    }),
                  },
                ],
              }
            }

            // Verify persistence by reading back
            const recheck = readMemoryStore()
            const verified = recheck[category]?.[key] === value

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: verified ? 'COMPLETED' : 'UNVERIFIED',
                    verificationDetails: verified
                      ? `Memory saved and verified in ${category}.${key}.`
                      : 'Saved to disk but readback verification could not confirm value.',
                    category,
                    key,
                    value,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Memory storage failed: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 2. RECALL MEMORY
      tool(
        'recall_memory',
        'Search or retrieve memories by query keyword or specific category.',
        {
          query: z.string().describe('Keyword or phrase to search across memories.'),
          category: z.enum(['all', 'user_preferences', 'facts', 'project_context', 'notes']).optional().describe('Category to search in (default: all).'),
        },
        async ({ query, category = 'all' }) => {
          try {
            const store = readMemoryStore()
            const q = query.toLowerCase().trim()
            const matches = []

            const searchInObj = (catName, obj) => {
              if (!obj || typeof obj !== 'object') return
              for (const [k, v] of Object.entries(obj)) {
                const strV = typeof v === 'object' ? JSON.stringify(v) : String(v)
                if (k.toLowerCase().includes(q) || strV.toLowerCase().includes(q)) {
                  matches.push({ category: catName, key: k, value: v })
                }
              }
            }

            if (category === 'all') {
              searchInObj('user_preferences', store.user_preferences)
              searchInObj('facts', store.facts)
              searchInObj('project_context', store.project_context)
              searchInObj('notes', store.notes)
            } else {
              searchInObj(category, store[category])
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Found ${matches.length} matching memory items.`,
                    query,
                    matches,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Memory recall failed: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 3. LIST MEMORIES
      tool(
        'list_memories',
        'List all stored memories in a specific category or the complete store.',
        {
          category: z.enum(['all', 'user_preferences', 'facts', 'project_context', 'notes']).optional().describe('Category to inspect (default: all).'),
        },
        async ({ category = 'all' }) => {
          try {
            const store = readMemoryStore()
            const output = category === 'all' ? store : { [category]: store[category] || {} }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: 'Memories retrieved from store.',
                    category,
                    data: output,
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to list memories: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 4. FORGET MEMORY
      tool(
        'forget_memory',
        'Remove a specific memory item from the store.',
        {
          category: z.enum(['user_preferences', 'facts', 'project_context', 'notes']).describe('Category of the memory to remove.'),
          key: z.string().describe('Key to delete.'),
        },
        async ({ category, key }) => {
          try {
            const store = readMemoryStore()
            if (!store[category] || !(key in store[category])) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: `Memory key '${key}' was not found in '${category}'. Nothing deleted.`,
                    }),
                  },
                ],
              }
            }

            delete store[category][key]
            writeMemoryStore(store)

            // Verify deletion
            const recheck = readMemoryStore()
            const deleted = !(key in (recheck[category] || {}))

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: deleted ? 'COMPLETED' : 'UNVERIFIED',
                    verificationDetails: deleted
                      ? `Successfully forgotten: ${category}.${key}`
                      : 'Deleted from object but persistence check failed.',
                  }, null, 2),
                },
              ],
            }
          } catch (err) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Failed to forget memory: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),
    ],
  })
}
