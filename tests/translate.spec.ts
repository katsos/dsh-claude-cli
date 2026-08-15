import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { translate } from '../src/translate.ts'

/** Wrap CLI stdout lines as the async iterable the translator consumes. */
async function* lines(...items: unknown[]): AsyncGenerator<string> {
  for (const item of items) yield typeof item === 'string' ? item : JSON.stringify(item)
}

/** A `stream_event` envelope carrying one raw Anthropic event. */
const event = (value: unknown): unknown => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: value,
})

const context = { harnessNames: {}, now: () => 1_000_000 }

/** Drain a translation into an array. */
async function collect(source: AsyncIterable<string>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translate(source, context)) chunks.push(chunk)
  return chunks
}

describe('translate', () => {
  it('streams a text message as block, deltas, usage, then finish', async () => {
    const chunks = await collect(lines(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' you' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
      event({ type: 'message_stop' }),
    ))

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hi' },
      { type: 'text-delta', index: 0, text: ' you' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi you' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('maps thinking blocks to reasoning and reports thinking tokens', async () => {
    const chunks = await collect(lines(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'weighing' },
      }),
      event({ type: 'content_block_stop', index: 0 }),
      event({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 5, output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } },
      }),
      event({ type: 'message_stop' }),
    ))

    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'weighing' })
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 9, reasoningTokens: 4 },
    })
  })

  it('recovers the harness tool name and streams raw JSON argument fragments', async () => {
    const chunks: StreamChunk[] = []
    const source = lines(
      event({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__todo_write' },
      }),
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"todos":' },
      }),
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '[]}' },
      }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      event({ type: 'message_stop' }),
    )
    for await (const chunk of translate(source, context)) chunks.push(chunk)

    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'toolu_1',
        name: 'todo_write',
        argumentsDelta: '{"todos":',
      },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'todo_write', argumentsDelta: '[]}' },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'toolu_1',
          name: 'todo_write',
          arguments: '{"todos":[]}',
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('applies the rewritten-name map when a tool name was not a legal wire name', async () => {
    const chunks: StreamChunk[] = []
    const source = lines(
      event({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'mcp__dsh__weird_name' },
      }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'message_stop' }),
    )
    for await (
      const chunk of translate(source, { ...context, harnessNames: { weird_name: 'weird.name' } })
    ) chunks.push(chunk)

    expect(chunks.at(-2)).toMatchObject({
      block: { type: 'tool-call', name: 'weird.name', arguments: '{}' },
    })
  })

  it('allocates harness block indexes in first-seen order and skips unmodeled blocks', async () => {
    const chunks = await collect(lines(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } }),
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'a' } }),
      event({ type: 'content_block_stop', index: 1 }),
      event({ type: 'message_stop' }),
    ))

    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'a' })
  })

  it('ignores nested subagent events', async () => {
    const chunks = await collect(lines(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_9',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      },
      event({ type: 'message_stop' }),
    ))

    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('classifies a missing login as MISSING_CREDENTIAL', async () => {
    const chunks = await collect(lines({
      type: 'assistant',
      error: 'authentication_failed',
      is_api_error_message: true,
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
    }))

    expect(chunks).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'Not logged in · Please run /login',
            code: 'MISSING_CREDENTIAL',
          },
        },
      },
    ])
  })

  it('turns a reported reset instant into a bounded retry delay', async () => {
    const chunks = await collect(lines(
      { type: 'rate_limit_event', rate_limit_info: { status: 'exceeded', resetsAt: 1030 } },
      {
        type: 'result',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 429,
        result: 'Usage limit reached',
      },
    ))

    expect(chunks[0]).toMatchObject({
      reason: {
        failure: { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 30_000 },
      },
    })
  })

  it('reports a response with no content as EMPTY_RESPONSE', async () => {
    const chunks = await collect(lines(
      event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      event({ type: 'message_stop' }),
    ))

    expect(chunks[0]).toMatchObject({ reason: { failure: { code: 'EMPTY_RESPONSE' } } })
  })

  it('closes an unterminated block when the process dies mid-message', async () => {
    const chunks = await collect(lines(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } }),
    ))

    expect(chunks.at(-2)).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'par' },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('skips non-JSON stdout lines the CLI interleaves', async () => {
    const chunks = await collect(lines(
      'Warning: no stdin data received in 3s, proceeding without it.',
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      event({ type: 'content_block_stop', index: 0 }),
      event({ type: 'message_stop' }),
    ))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
