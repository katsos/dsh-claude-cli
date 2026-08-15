/**
 * Translation of CLI output lines into the harness {@link StreamChunk}
 * protocol.
 *
 * One harness request is exactly one model message. The CLI would happily keep
 * going after a tool call — it has its own agent loop — so this translator
 * ends the stream at the end of the first model message and lets the adapter
 * tear the process down. Everything the CLI emits afterwards belongs to a turn
 * the harness never asked for.
 *
 * @module dsh-claude-cli/translate
 */

import {
  CallId,
  EMPTY_RESPONSE_CODE,
  type ContentBlock,
  type FinishReason,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { classifyCliError, cliFailure, retryAfterMs, CLI_EXIT_CODE } from './failure.ts'
import { parseCliLine, type CliLine, type WireUsage } from './protocol.ts'
import { harnessToolName } from './tools.ts'

/** One content block being assembled from wire events. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  toolName?: string
}

/** Context one translation needs beyond the lines themselves. */
export interface TranslateContext {
  /** Bridge-to-harness tool names from `buildToolBridgeSpec`. */
  harnessNames: Readonly<Record<string, string>>
  /** Wall-clock source, so a rate-limit reset instant becomes a delay. */
  now: () => number
}

/**
 * Convert wire usage into harness token accounting.
 *
 * The provider already reports uncached input separately from cache reads and
 * writes, so the counts are disjoint as the harness requires and need no
 * subtraction.
 *
 * @param usage - the wire usage object, when the CLI supplied one.
 * @returns harness usage, or undefined when no counts were reported.
 */
export function toTokenUsage(usage: WireUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const thinking = usage.output_tokens_details?.thinking_tokens
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...usage.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadTokens: usage.cache_read_input_tokens },
    ...usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cache_creation_input_tokens },
    ...thinking === undefined ? {} : { reasoningTokens: thinking },
  }
}

/**
 * Assemble the finished block for one open wire block.
 * @param block - the block's accumulated state.
 * @returns the complete content block carried by `block-end`.
 */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: CallId(block.callId ?? ''),
        name: block.toolName ?? '',
        arguments: block.text.length === 0 ? '{}' : block.text,
      }
  }
}

/**
 * Map a provider stop reason onto a harness finish reason.
 * @param stopReason - the wire `stop_reason`, when the CLI reported one.
 * @param sawToolCall - whether the message contained a tool-call block.
 * @returns the finish reason for a message that completed normally.
 */
function finishReasonOf(stopReason: string | undefined, sawToolCall: boolean): FinishReason {
  if (sawToolCall || stopReason === 'tool_use') return { kind: 'tool-calls' }
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/**
 * Translate one CLI run's stdout lines into harness chunks.
 *
 * Terminates after the first `finish`, which is also the point at which the
 * caller stops the process.
 *
 * @param lines - stdout lines in order.
 * @param context - tool-name recovery and a clock.
 * @returns the chunk stream for one model call.
 */
export async function* translate(
  lines: AsyncIterable<string>,
  context: TranslateContext,
): AsyncGenerator<StreamChunk> {
  const open = new Map<number, OpenBlock>()
  let nextIndex = 0
  let usage: TokenUsage | undefined
  let stopReason: string | undefined
  let sawToolCall = false
  let sawContent = false
  let rateLimitResetsAt: number | undefined

  /** Emit usage then the terminal finish, in the order the contract fixes. */
  function* finish(reason: FinishReason): Generator<StreamChunk> {
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason }
  }

  /** Build a terminal error finish from CLI-reported failure text. */
  function* failWith(message: string, cliError?: string, status?: number): Generator<StreamChunk> {
    const code = classifyCliError(cliError, message)
    const delay = retryAfterMs(rateLimitResetsAt, context.now())
    yield* finish({
      kind: 'error',
      failure: cliFailure(message, code, {
        ...status === undefined ? {} : { status },
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
      }),
    })
  }

  for await (const raw of lines) {
    const line: CliLine | undefined = parseCliLine(raw)
    if (line === undefined) continue

    if (line.type === 'rate_limit_event') {
      rateLimitResetsAt = line.rate_limit_info?.resetsAt
      continue
    }

    if (line.type === 'assistant' && line.is_api_error_message === true) {
      const text = line.message?.content?.map((block) => block.text ?? '').join('') ?? ''
      yield* failWith(text.length > 0 ? text : 'The Claude CLI reported an API error.', line.error)
      return
    }

    if (line.type === 'result' && line.is_error === true) {
      yield* failWith(
        line.result ?? 'The Claude CLI reported a failed result.',
        line.terminal_reason,
        line.api_error_status ?? undefined,
      )
      return
    }

    if (line.type !== 'stream_event') continue
    // Nested subagent output belongs to a turn the harness did not request.
    if (line.parent_tool_use_id != null) continue

    const event = line.event
    if (event === undefined) continue

    switch (event.type) {
      case 'content_block_start': {
        const wireIndex = event.index ?? 0
        const wireBlock = event.content_block
        const kind = wireBlock?.type === 'text'
          ? 'text'
          : wireBlock?.type === 'thinking'
            ? 'reasoning'
            : wireBlock?.type === 'tool_use'
              ? 'tool-call'
              : undefined
        // A block type this adapter has no harness equivalent for contributes
        // no chunks, and must not consume a harness block index.
        if (kind === undefined) break
        const block: OpenBlock = { index: nextIndex, kind, text: '' }
        nextIndex += 1
        if (kind === 'tool-call' && wireBlock?.type === 'tool_use') {
          block.callId = wireBlock.id ?? ''
          block.toolName = harnessToolName(wireBlock.name ?? '', context.harnessNames)
            ?? wireBlock.name ?? ''
          sawToolCall = true
        }
        open.set(wireIndex, block)
        sawContent = true
        yield { type: 'block-start', index: block.index, blockType: kind }
        break
      }

      case 'content_block_delta': {
        const block = open.get(event.index ?? 0)
        const delta = event.delta
        if (block === undefined || delta === undefined) break
        if (delta.type === 'text_delta' && block.kind === 'text') {
          const text = delta.text ?? ''
          if (text.length === 0) break
          block.text += text
          yield { type: 'text-delta', index: block.index, text }
        } else if (delta.type === 'thinking_delta' && block.kind === 'reasoning') {
          const text = delta.thinking ?? ''
          if (text.length === 0) break
          block.text += text
          yield { type: 'reasoning-delta', index: block.index, text }
        } else if (delta.type === 'input_json_delta' && block.kind === 'tool-call') {
          const fragment = delta.partial_json ?? ''
          if (fragment.length === 0) break
          block.text += fragment
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: CallId(block.callId ?? ''),
            ...block.toolName === undefined ? {} : { name: block.toolName },
            argumentsDelta: fragment,
          }
        }
        break
      }

      case 'content_block_stop': {
        const wireIndex = event.index ?? 0
        const block = open.get(wireIndex)
        if (block === undefined) break
        open.delete(wireIndex)
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        break
      }

      case 'message_delta': {
        stopReason = event.delta?.stop_reason ?? stopReason
        usage = toTokenUsage(event.usage) ?? usage
        break
      }

      case 'message_start': {
        usage = toTokenUsage(event.message?.usage) ?? usage
        break
      }

      case 'message_stop': {
        // Blocks the provider never closed still owe a `block-end`.
        for (const [wireIndex, block] of open) {
          open.delete(wireIndex)
          yield { type: 'block-end', index: block.index, block: closeBlock(block) }
        }
        if (!sawContent) {
          yield* finish({
            kind: 'error',
            failure: cliFailure(
              'The model returned a response with no content.',
              EMPTY_RESPONSE_CODE,
            ),
          })
          return
        }
        yield* finish(finishReasonOf(stopReason, sawToolCall))
        return
      }

      default:
        break
    }
  }

  // Stdout ended without a `message_stop`: the process died mid-message.
  for (const [wireIndex, block] of open) {
    open.delete(wireIndex)
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }
  if (sawContent) {
    yield* finish(finishReasonOf(stopReason, sawToolCall))
    return
  }
  yield* finish({
    kind: 'error',
    failure: cliFailure('The Claude CLI exited before producing a response.', CLI_EXIT_CODE),
  })
}
