/**
 * SPARK Messaging & Communication Engine.
 *
 * Implements WhatsApp and Email dispatch with strict security gating.
 * External communications are NEVER dispatched silently: they require
 * explicit user authorization (confirmed: true).
 *
 * Adheres strictly to the SPARK Action Verification Framework:
 * All tools return { status: 'COMPLETED' | 'UNVERIFIED' | 'FAILED' | 'NEEDS_APPROVAL', verificationDetails: string }
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { activateWindow, isProcessRunning } from './windows.mjs'

export function messagingServer({ allowWrites = true } = {}) {
  return createSdkMcpServer({
    name: 'spark_messaging',
    version: '1.0.0',
    tools: [
      // 1. SEND MESSAGE
      tool(
        'send_message',
        'Draft or send a message via WhatsApp or Email. Requires confirmed: true for actual dispatch; returns NEEDS_APPROVAL if unconfirmed.',
        {
          platform: z.enum(['whatsapp', 'email']).describe('Communication channel to use.'),
          recipient: z.string().describe('Recipient phone number (with country code for WhatsApp) or email address.'),
          message: z.string().describe('Message text body.'),
          subject: z.string().optional().describe('Subject line for emails.'),
          confirmed: z.boolean().optional().describe('Explicit user confirmation to send the message. Must be true to dispatch.'),
        },
        async ({ platform, recipient, message, subject = 'Message from SPARK', confirmed = false }) => {
          // Strict approval gate
          if (!confirmed) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'NEEDS_APPROVAL',
                    verificationDetails: `Draft prepared for ${platform}. Please confirm before dispatching: set confirmed: true or reply 'approve'.`,
                    draft: {
                      platform,
                      recipient,
                      subject: platform === 'email' ? subject : undefined,
                      message,
                    },
                  }, null, 2),
                },
              ],
            }
          }

          if (!allowWrites) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: 'Permission denied: external communications require JARVIS_ALLOW_WRITES=1.',
                  }),
                },
              ],
            }
          }

          try {
            if (platform === 'whatsapp') {
              const cleanNumber = recipient.replace(/[^0-9]/g, '')
              // Try WhatsApp URI scheme
              const uri = cleanNumber
                ? `whatsapp://send?phone=${cleanNumber}&text=${encodeURIComponent(message)}`
                : `whatsapp://send?text=${encodeURIComponent(message)}`

              const child = spawn('cmd.exe', ['/c', 'start', '""', uri], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              })
              child.unref()

              // Bring WhatsApp window to front
              await new Promise((r) => setTimeout(r, 600))
              activateWindow('WhatsApp')

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: `WhatsApp opened in foreground with message draft for ${recipient}.`,
                      platform: 'whatsapp',
                      recipient,
                    }, null, 2),
                  },
                ],
              }
            }

            if (platform === 'email') {
              const mailtoUri = `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`
              const child = spawn('cmd.exe', ['/c', 'start', '""', mailtoUri], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              })
              child.unref()

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      status: 'COMPLETED',
                      verificationDetails: `Email draft prepared and opened in default mail client for ${recipient}.`,
                      platform: 'email',
                      recipient,
                      subject,
                    }, null, 2),
                  },
                ],
              }
            }

            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Unsupported platform: ${platform}`,
                  }),
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
                    verificationDetails: `Message dispatch error: ${err.message}`,
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
