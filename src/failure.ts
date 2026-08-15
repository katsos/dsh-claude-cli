/**
 * Classification of Claude Code CLI failures into provider-neutral
 * {@link LlmFailure} facts.
 *
 * The CLI reports failures three ways: a non-zero exit with no `result` line,
 * an `assistant` line flagged `is_api_error_message` carrying an `error` code,
 * and a terminal `result` line with `is_error`. All three land here so that
 * consumers route on `code` and never on provider text.
 *
 * @module dsh-claude-cli/failure
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  INVALID_CREDENTIAL_CODE,
  QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError,
  type LlmFailure,
} from '@deepseek-ai/dsh-llm'

/** The `claude` executable was not found or could not be spawned. */
export const CLI_NOT_FOUND_CODE = 'CLI_NOT_FOUND'

/** The CLI exited before emitting a usable model response. */
export const CLI_EXIT_CODE = 'CLI_EXIT'

/** The CLI is installed but has no usable Claude login. */
export const MISSING_CREDENTIAL_CODE = 'MISSING_CREDENTIAL'

/** The account's usage window is exhausted; `providerRetryAfterMs` carries the reset delay. */
export const RATE_LIMIT_CODE = 'RATE_LIMIT'

/** A CLI failure this adapter could not classify further. */
export const PROVIDER_ERROR_CODE = 'PROVIDER_ERROR'

/** A `GenerateOptions` field the CLI has no way to honor. */
export const UNSUPPORTED_CODE = 'UNSUPPORTED'

/** No output was produced within the configured idle window. */
export const TIMEOUT_CODE = 'TIMEOUT'

/** The caller aborted the request. */
export const ABORTED_CODE = 'ABORTED'

/** Upper bound on a provider-requested delay this adapter will report, in milliseconds. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Map a CLI error code and message onto a provider-neutral failure code.
 *
 * Ordering matters: credential and quota failures are checked before the
 * generic context-overflow text match, because their messages never describe a
 * context bound and an earlier match would mask the more actionable code.
 *
 * @param cliError - the CLI's own error identifier, when it supplied one.
 * @param message - the human-readable failure text.
 * @returns the stable code consumers route on.
 */
export function classifyCliError(cliError: string | undefined, message: string): string {
  const detail = `${cliError ?? ''} ${message}`.toLowerCase()
  if (detail.includes('authentication_failed') || detail.includes('not logged in')
    || detail.includes('please run /login')) {
    return MISSING_CREDENTIAL_CODE
  }
  if (detail.includes('invalid api key') || detail.includes('invalid_api_key')) {
    return INVALID_CREDENTIAL_CODE
  }
  if (detail.includes('rate_limit') || detail.includes('rate limit')
    || detail.includes('usage limit')) {
    return RATE_LIMIT_CODE
  }
  if (detail.includes('credit balance') || detail.includes('insufficient_quota')) {
    return QUOTA_EXCEEDED_CODE
  }
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  return PROVIDER_ERROR_CODE
}

/**
 * Convert a rate-limit reset instant into a delay this adapter may report.
 * @param resetsAtUnixSeconds - the CLI-reported reset instant, in Unix seconds.
 * @param nowMs - current wall-clock time in milliseconds.
 * @returns a positive bounded delay, or undefined when the instant is absent,
 *   already past, or implausibly far away.
 */
export function retryAfterMs(
  resetsAtUnixSeconds: number | undefined,
  nowMs: number,
): number | undefined {
  if (typeof resetsAtUnixSeconds !== 'number' || !Number.isFinite(resetsAtUnixSeconds)) {
    return undefined
  }
  const delay = resetsAtUnixSeconds * 1000 - nowMs
  if (delay <= 0 || delay > MAX_RETRY_AFTER_MS) return undefined
  return Math.round(delay)
}

/**
 * Build a failure record from classified CLI facts.
 * @param message - human-readable failure text.
 * @param code - the stable code from {@link classifyCliError} or a constant here.
 * @param extra - optional HTTP status, retry delay, and CLI session id.
 * @returns the provider-neutral failure.
 */
export function cliFailure(
  message: string,
  code: string,
  extra: { status?: number; providerRetryAfterMs?: number } = {},
): LlmFailure {
  return {
    message,
    code,
    ...extra.status === undefined ? {} : { status: extra.status },
    ...extra.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: extra.providerRetryAfterMs },
  }
}
