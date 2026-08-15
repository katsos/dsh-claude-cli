/**
 * End-to-end checks against the real `claude` executable.
 *
 * Run with `npx vitest run tests/adapter.e2e.ts`. They self-skip when the CLI
 * is absent, and they spend real tokens on the logged-in account when it is.
 */

import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { BlockAssembler, MessageId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeCliAdapter } from '../src/adapter.ts'

/** Whether a usable `claude` executable is on PATH. */
const available = ((): boolean => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    // No CLI on this machine: these tests describe the CLI's behavior and have
    // nothing to assert without it.
    return false
  }
})()

const adapter = new ClaudeCliAdapter({
  executable: 'claude',
  cwd: process.cwd(),
  streamIdleTimeoutMs: 120_000,
  unsupportedFields: 'error',
  extraArgs: [],
})

const user = (text: string): Message => ({
  id: MessageId('m1'),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

/** Drain one adapter stream into chunks. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe.skipIf(!available)('ClaudeCliAdapter against the real CLI', () => {
  it('streams a text answer and reports usage before finishing', { timeout: 120_000 }, async () => {
    const chunks = await collect(adapter.stream({
      provider: 'anthropic-claude-cli',
      model: 'haiku',
      system: 'You are terse. Answer with a single word.',
      messages: [user('What is the capital of France?')],
    }))

    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.usage?.inputTokens).toBeGreaterThan(0)
    expect(assembler.usage?.outputTokens).toBeGreaterThan(0)

    const text = assembler.blocks()
      .map((block) => block.type === 'text' ? block.text : '')
      .join('')
    expect(text.toLowerCase()).toContain('paris')

    // The contract: usage precedes finish, and finish is last.
    const finishAt = chunks.findIndex((chunk) => chunk.type === 'finish')
    const usageAt = chunks.findIndex((chunk) => chunk.type === 'usage')
    expect(usageAt).toBeGreaterThanOrEqual(0)
    expect(usageAt).toBeLessThan(finishAt)
    expect(finishAt).toBe(chunks.length - 1)
  })

  it('returns a native tool call with valid JSON arguments', { timeout: 120_000 }, async () => {
    const chunks = await collect(adapter.stream({
      provider: 'anthropic-claude-cli',
      model: 'haiku',
      system: 'You are a shell agent. Use the run_command tool to do what the user asks.',
      messages: [user('List the files in the current directory.')],
      tools: [{
        name: 'run_command',
        description: 'Run a shell command in the workspace and return its output.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'The shell command to run.' } },
          required: ['command'],
        },
      }],
    }))

    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)

    expect(assembler.finish).toEqual({ kind: 'tool-calls' })

    const call = assembler.blocks().find((block) => block.type === 'tool-call')
    expect(call).toBeDefined()
    if (call?.type !== 'tool-call') throw new Error('expected a tool-call block')
    expect(call.name).toBe('run_command')
    expect(call.id).not.toBe('')
    expect(JSON.parse(call.arguments)).toMatchObject({ command: expect.any(String) })
  })

  it('stops promptly when the caller aborts', { timeout: 120_000 }, async () => {
    const controller = new AbortController()
    const stream = adapter.stream({
      provider: 'anthropic-claude-cli',
      model: 'haiku',
      system: 'You are verbose.',
      messages: [user('Write a very long essay about the sea.')],
      signal: controller.signal,
    })

    const started = Date.now()
    await expect(async () => {
      for await (const _chunk of stream) controller.abort()
    }).rejects.toMatchObject({ code: 'ABORTED' })
    expect(Date.now() - started).toBeLessThan(60_000)
  })

  it('rejects a request field the CLI cannot honor', async () => {
    await expect(collect(adapter.stream({
      provider: 'anthropic-claude-cli',
      model: 'haiku',
      messages: [user('hi')],
      temperature: 0.5,
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})
