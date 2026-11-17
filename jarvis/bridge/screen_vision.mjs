/**
 * SPARK Desktop Screen Vision Engine.
 *
 * Captures the active Windows desktop and performs multimodal visual analysis
 * using Google Gemini 3.6 Flash (@google/genai).
 *
 * Adheres strictly to the SPARK Action Verification Framework:
 * All tools return { status: 'COMPLETED' | 'UNVERIFIED' | 'FAILED' | 'NEEDS_APPROVAL', verificationDetails: string }
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { GoogleGenAI } from '@google/genai'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { getSparkWorkspaceRoot } from './windows.mjs'

const execAsync = promisify(exec)

/**
 * Captures primary desktop screen to a PNG file.
 */
async function captureDesktopScreenshot(outputPath) {
  const safeEscapedPath = outputPath.replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
    'try {',
    '  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    `  $bmp.Save('${safeEscapedPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '  Write-Output "OK"',
    '} catch {',
    '  Write-Error $_.Exception.Message',
    '} finally {',
    '  $graphics.Dispose()',
    '  $bmp.Dispose()',
    '}',
  ].join('; ')

  const { stdout, stderr } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '`"')}"`,
    { timeout: 10_000, windowsHide: true },
  )

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Screenshot capture failed: ${stderr || stdout || 'Unknown error'}`)
  }

  return outputPath
}

export function screenVisionServer({ apiKey, model = 'gemini-3.6-flash' } = {}) {
  const activeKey = apiKey || process.env.GEMINI_API_KEY
  let ai = null
  if (activeKey) {
    try {
      ai = new GoogleGenAI({ apiKey: activeKey })
    } catch (err) {
      console.warn('[spark:vision] Gemini client initialization warning:', err.message)
    }
  }

  return createSdkMcpServer({
    name: 'spark_vision',
    version: '1.0.0',
    tools: [
      // 1. ANALYZE ACTIVE SCREEN
      tool(
        'analyze_screen',
        'Capture the Windows desktop screen and perform visual analysis using Gemini Multimodal Vision.',
        {
          query: z.string().optional().describe('Question or instructions about what to look for on the screen (e.g. "What is visible on my screen?", "Read the error message", "Where is the submit button?").'),
        },
        async ({ query = 'Describe what is currently visible on the desktop screen, including open windows, applications, and any key notifications.' }) => {
          const outputDir = path.resolve(getSparkWorkspaceRoot(), 'jarvis', 'scratch', 'screenshots')
          fs.mkdirSync(outputDir, { recursive: true })
          const screenshotFile = path.join(outputDir, `screen_vision_${Date.now()}.png`)

          try {
            await captureDesktopScreenshot(screenshotFile)
          } catch (capErr) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Desktop capture failed: ${capErr.message}`,
                  }),
                },
              ],
            }
          }

          if (!ai || !activeKey) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'UNVERIFIED',
                    verificationDetails: 'Screenshot saved to disk, but Gemini Multimodal Vision API key is not configured.',
                    screenshotPath: screenshotFile,
                    analysis: 'Desktop screenshot saved. Configure GEMINI_API_KEY to enable automated visual analysis.',
                  }, null, 2),
                },
              ],
            }
          }

          try {
            const imageBuffer = fs.readFileSync(screenshotFile)
            const base64Data = imageBuffer.toString('base64')

            const prompt = `You are SPARK Vision. You are looking at a screenshot of the user's Windows computer desktop.
User query: ${query}

Provide a direct, precise, factual answer based ONLY on what is visually verifiable in the screenshot.
State which applications are open, what text or dialogs are shown, and any actionable coordinates or elements.`

            const response = await ai.models.generateContent({
              model,
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: base64Data,
                      },
                    },
                  ],
                },
              ],
            })

            const analysisText = response.text || 'Screen analyzed successfully.'

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'COMPLETED',
                    verificationDetails: 'Screen captured and analyzed with Gemini Multimodal Vision.',
                    screenshotPath: screenshotFile,
                    analysis: analysisText,
                  }, null, 2),
                },
              ],
            }
          } catch (visionErr) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'FAILED',
                    verificationDetails: `Visual analysis failed: ${visionErr.message}`,
                    screenshotPath: screenshotFile,
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
