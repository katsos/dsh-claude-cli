/**
 * The Claude Code CLI `--output-format stream-json` wire vocabulary, narrowed
 * to the fields this adapter reads.
 *
 * The CLI emits one JSON object per stdout line. With
 * `--include-partial-messages` the `stream_event` envelope carries the raw
 * Anthropic Messages streaming events verbatim, which is the only source this
 * adapter translates; the aggregated `assistant` lines repeat the same content
 * and are ignored. Every declared field is optional or nullable exactly where
 * the CLI leaves it so, because this is a process boundary: the CLI is a
 * separately versioned program and its output is parsed, not type-checked.
 *
 * @module dsh-claude-cli/protocol
 */

/** Anthropic per-message token accounting as it appears on the wire. */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number } | null
}

/**
 * The `content_block` opened by a `content_block_start` event.
 *
 * Every union in this module lists only the variants this adapter models, so
 * that testing `type` narrows. The CLI emits variants none of them name; a
 * value whose `type` matches no listed variant is simply unhandled, which is
 * the intended behavior for a wire vocabulary that grows without notice.
 */
export type WireContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string }

/** The `delta` carried by a `content_block_delta` event. */
export type WireDelta =
  | { type: 'text_delta'; text?: string }
  | { type: 'thinking_delta'; thinking?: string }
  | { type: 'input_json_delta'; partial_json?: string }

/** One raw Anthropic Messages streaming event, as re-emitted by the CLI. */
export type WireStreamEvent =
  | { type: 'message_start'; message?: { id?: string; usage?: WireUsage } }
  | { type: 'content_block_start'; index?: number; content_block?: WireContentBlock }
  | { type: 'content_block_delta'; index?: number; delta?: WireDelta }
  | { type: 'content_block_stop'; index?: number }
  | {
    type: 'message_delta'
    delta?: { stop_reason?: string | null }
    usage?: WireUsage
  }
  | { type: 'message_stop' }

/** Rate-limit facts the CLI reports out of band, used to time a retry. */
export interface WireRateLimitInfo {
  status?: string
  /** Unix seconds at which the exhausted window resets. */
  resetsAt?: number
  rateLimitType?: string
}

/**
 * One parsed CLI stdout line.
 *
 * `result` is terminal and always last when the CLI runs to completion; this
 * adapter usually stops before it, because a turn that requests a tool is
 * complete for the harness the moment the model's message ends.
 */
export type CliLine =
  | { type: 'system'; subtype?: string; session_id?: string; model?: string }
  | {
    type: 'stream_event'
    event?: WireStreamEvent
    /** Non-null only for nested subagent output, which this adapter drops. */
    parent_tool_use_id?: string | null
    session_id?: string
  }
  | {
    type: 'assistant'
    /** Present when the CLI reports an API failure in place of a model message. */
    error?: string
    is_api_error_message?: boolean
    message?: { content?: { type: string; text?: string }[] }
  }
  | { type: 'rate_limit_event'; rate_limit_info?: WireRateLimitInfo }
  | {
    type: 'result'
    subtype?: string
    is_error?: boolean
    /** `completed`, `api_error`, and other CLI-owned terminal classifications. */
    terminal_reason?: string
    api_error_status?: number | null
    result?: string
    usage?: WireUsage
    session_id?: string
  }

/**
 * Parse one CLI stdout line.
 * @param line - a single non-empty stdout line.
 * @returns the parsed object, or undefined when the line is not JSON (the CLI
 *   interleaves plain-text warnings on stdout in some configurations).
 */
export function parseCliLine(line: string): CliLine | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record['type'] !== 'string') return undefined
    return record as CliLine
  } catch {
    // Malformed JSON on a process boundary: a truncated or interleaved line is
    // not a protocol event, and nothing else in this adapter can observe it.
    return undefined
  }
}
