/**
 * DeepSeek Harness plugin registering the locally installed Claude Code CLI as
 * an LLM provider route.
 *
 * @module dsh-claude-cli
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ClaudeCliAdapter } from './adapter.ts'

export { ClaudeCliAdapter } from './adapter.ts'

/** Plugin configuration. */
export interface Config {
  /** Provider routes this adapter serves. */
  providers: string[]
  /** Path or command name of the `claude` executable. */
  executable: string
  /** Working directory for the CLI process; defaults to the harness's own. */
  cwd?: string
  /** Maximum time between CLI output lines before a request fails as `TIMEOUT`. */
  streamIdleTimeoutMs: number
  /** What to do with a request field the CLI cannot honor. */
  unsupportedFields: 'error' | 'ignore'
  /** Reasoning effort materialized into requests that omit one. */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /**
   * Extra arguments for CLI flags this plugin does not model. They are passed
   * before the plugin's own flags and may not name one of them.
   */
  extraArgs: string[]
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(String).default(['claude-cli'])
    .description('Provider routes this adapter serves.'),
  executable: Schema.string().default('claude')
    .description('Path or command name of the Claude Code CLI executable.'),
  cwd: Schema.string()
    .description('Working directory for the CLI process; defaults to the harness process cwd.'),
  streamIdleTimeoutMs: Schema.natural().default(300_000)
    .description('Maximum milliseconds between CLI output lines before the request fails.'),
  unsupportedFields: Schema.union(['error', 'ignore'] as const).default('error')
    .description('Whether to reject or drop request fields the CLI cannot honor.'),
  defaultEffort: Schema.union(['low', 'medium', 'high', 'xhigh', 'max'] as const)
    .description('Reasoning effort used when a request does not select one.'),
  extraArgs: Schema.array(String).default([])
    .description(
      'Extra arguments for CLI flags this plugin does not model. Passed before'
      + " the plugin's own flags; naming one of them is rejected at startup.",
    ),
})

export const name = 'claude-cli'
export const inject = ['llm']

/**
 * Register the adapter on the LLM seam.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = new ClaudeCliAdapter({
    executable: config.executable,
    cwd: config.cwd ?? process.cwd(),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    unsupportedFields: config.unsupportedFields,
    ...config.defaultEffort === undefined ? {} : { defaultEffort: config.defaultEffort },
    extraArgs: config.extraArgs,
  })
  ctx.llm.registerAdapter(config.providers, adapter)
}
