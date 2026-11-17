/**
 * SPARK Autonomous Background Task Engine.
 *
 * Manages asynchronous multi-step tasks across their full lifecycle:
 * QUEUED -> PLANNING -> RUNNING -> VERIFYING -> COMPLETED / FAILED / NEEDS_APPROVAL
 *
 * Emits progress events over WebSockets to provide real-time status in the SPARK HUD.
 *
 * Adheres strictly to the SPARK Action Verification Framework:
 * All tools return { status: 'COMPLETED' | 'UNVERIFIED' | 'FAILED' | 'NEEDS_APPROVAL', verificationDetails: string }
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { getSparkWorkspaceRoot } from './windows.mjs'

export const taskEvents = new EventEmitter()

function getTasksStorePath() {
  const root = getSparkWorkspaceRoot()
  const memDir = path.join(root, 'jarvis', 'memory')
  if (!fs.existsSync(memDir)) {
    fs.mkdirSync(memDir, { recursive: true })
  }
  return path.join(memDir, 'tasks.json')
}

function readTasks() {
  const storePath = getTasksStorePath()
  try {
    if (!fs.existsSync(storePath)) {
      const initial = { tasks: [] }
      fs.writeFileSync(storePath, JSON.stringify(initial, null, 2), 'utf8')
      return initial
    }
    return JSON.parse(fs.readFileSync(storePath, 'utf8'))
  } catch (err) {
    return { tasks: [] }
  }
}

function writeTasks(data) {
  const storePath = getTasksStorePath()
  try {
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function tasksServer() {
  return createSdkMcpServer({
    name: 'spark_tasks',
    version: '1.0.0',
    tools: [
      // 1. CREATE TASK
      tool(
        'create_task',
        'Create and enqueue a background or multi-step autonomous task.',
        {
          title: z.string().describe('Short title for the task.'),
          description: z.string().describe('Detailed objective or instructions.'),
          priority: z.enum(['low', 'normal', 'high']).optional().describe('Task priority (default: normal).'),
        },
        async ({ title, description, priority = 'normal' }) => {
          try {
            const data = readTasks()
            const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
            const newTask = {
              id: taskId,
              title,
              description,
              priority,
              status: 'QUEUED',
              progress: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              steps: [],
              notes: '',
            }

            data.tasks.push(newTask)
            writeTasks(data)

            taskEvents.emit('task_update', { event: 'created', task: newTask })

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Task '${title}' created with ID ${taskId} in state QUEUED.`,
                    task: newTask,
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
                    verificationDetails: `Failed to create task: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 2. LIST TASKS
      tool(
        'list_tasks',
        'List background tasks, optionally filtered by status (QUEUED, PLANNING, RUNNING, VERIFYING, COMPLETED, FAILED, NEEDS_APPROVAL).',
        {
          status: z.enum(['all', 'QUEUED', 'PLANNING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'NEEDS_APPROVAL']).optional().describe('Status filter (default: all).'),
        },
        async ({ status = 'all' }) => {
          try {
            const data = readTasks()
            const filtered = status === 'all'
              ? data.tasks
              : data.tasks.filter((t) => t.status === status)

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Retrieved ${filtered.length} tasks.`,
                    count: filtered.length,
                    tasks: filtered,
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
                    verificationDetails: `Failed to list tasks: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 3. UPDATE TASK PROGRESS & STATE
      tool(
        'update_task',
        'Update the lifecycle state, progress percentage, or step notes of a background task.',
        {
          taskId: z.string().describe('The task ID to update.'),
          status: z.enum(['QUEUED', 'PLANNING', 'RUNNING', 'VERIFYING', 'COMPLETED', 'FAILED', 'NEEDS_APPROVAL']).optional().describe('New lifecycle state.'),
          progress: z.number().min(0).max(100).optional().describe('Progress percentage (0 to 100).'),
          notes: z.string().optional().describe('Progress update note or log output.'),
        },
        async ({ taskId, status, progress, notes }) => {
          try {
            const data = readTasks()
            const task = data.tasks.find((t) => t.id === taskId)
            if (!task) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'FAILED',
                      verificationDetails: `Task '${taskId}' not found.`,
                    }),
                  },
                ],
              }
            }

            if (status) task.status = status
            if (progress !== undefined) task.progress = progress
            if (notes) {
              task.notes = (task.notes ? `${task.notes}\n` : '') + `[${new Date().toLocaleTimeString()}] ${notes}`
            }
            task.updatedAt = new Date().toISOString()

            writeTasks(data)
            taskEvents.emit('task_update', { event: 'updated', task })

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Task '${taskId}' updated to state ${task.status} (${task.progress}%).`,
                    task,
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
                    verificationDetails: `Failed to update task: ${err.message}`,
                  }),
                },
              ],
            }
          }
        },
      ),

      // 4. CANCEL TASK
      tool(
        'cancel_task',
        'Cancel an active or queued background task.',
        {
          taskId: z.string().describe('The task ID to cancel.'),
        },
        async ({ taskId }) => {
          try {
            const data = readTasks()
            const task = data.tasks.find((t) => t.id === taskId)
            if (!task) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'FAILED',
                      verificationDetails: `Task '${taskId}' not found.`,
                    }),
                  },
                ],
              }
            }

            task.status = 'FAILED'
            task.notes = (task.notes ? `${task.notes}\n` : '') + `[${new Date().toLocaleTimeString()}] Task cancelled by user/agent.`
            task.updatedAt = new Date().toISOString()

            writeTasks(data)
            taskEvents.emit('task_update', { event: 'cancelled', task })

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: `Task '${taskId}' cancelled.`,
                    task,
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
                    verificationDetails: `Failed to cancel task: ${err.message}`,
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
