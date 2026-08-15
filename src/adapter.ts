/**
 * The `LlmAdapter` implementation backed by the Claude Code CLI.
 *
 * Each request runs one `claude --print` process with the CLI's own agent
 * behavior switched off: its built-in tools are disabled, its settings sources
 * are not loaded, and its session is not persisted. What remains is the model
 * call itself, driven by the harness's system prompt, history, and tools.
 *
 * Authentication is the CLI's, not the harness's. There is no API key to
 * configure — whatever `claude` is already logged in as is what runs.
 *
 * @module dsh-claude-cli/adapter
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { runCli, type CliInvocation } from './cli.ts'
import { UNSUPPORTED_CODE } from './failure.ts'
import { contextWindowOf, displayNameOf, listCatalog, REASONING_EFFORTS } from './models.ts'
import { renderConversation } from './render.ts'
import { translate } from './translate.ts'
import { buildToolBridgeSpec, MCP_SERVER_NAME } from './tools.ts'

/** Absolute path to the MCP bridge the CLI launches. */
const BRIDGE_PATH = fileURLToPath(new URL('../bridge.mjs', import.meta.url))

/** Resolved adapter configuration. */
export interface AdapterOptions {
  /** Path or command name of the `claude` executable. */
  executable: string
  /** Working directory for the CLI process. */
  cwd: string
  /** Maximum time between stdout lines before the request fails as `TIMEOUT`. */
  streamIdleTimeoutMs: number
  /**
   * What to do with a request field the CLI cannot honor. `error` reports it
   * as `UNSUPPORTED` per the adapter contract; `ignore` drops it, which makes
   * the provider usable from an agent preset that sets such a field for every
   * route it might run on.
   */
  unsupportedFields: 'error' | 'ignore'
  /** Reasoning effort materialized into requests that omit one. */
  defaultEffort?: string
  /**
   * Extra arguments for CLI flags not modeled here. Placed *before* the
   * adapter's own flags so they cannot override them, and rejected outright
   * when they name a flag in {@link RESERVED_FLAGS}.
   */
  extraArgs: readonly string[]
}

/** Request fields the CLI has no flag for. */
const UNSUPPORTED: readonly (keyof GenerateOptions)[] = ['temperature', 'maxTokens', 'stop']

/**
 * CLI flags `extraArgs` may not carry.
 *
 * Two kinds, rejected for one reason. The first are flags this adapter sets
 * itself: the CLI keeps the last occurrence of a flag, so a duplicate would
 * silently win over the value the adapter chose. The second are flags that
 * re-grant the capability the adapter exists to withhold — tools, settings
 * sources, filesystem reach, or a different system prompt.
 *
 * Together they close the hole where one appended `--tools default` restores
 * the CLI's whole tool set inside the harness's working directory.
 */
const RESERVED_FLAGS: ReadonlySet<string> = new Set([
  // Owned by the adapter: protocol framing, model selection, prompt.
  '--print', '-p',
  '--input-format', '--output-format', '--include-partial-messages', '--verbose',
  '--no-session-persistence', '--strict-mcp-config', '--mcp-config',
  '--model', '--effort',
  '--system-prompt', '--system-prompt-file',
  '--append-system-prompt', '--append-system-prompt-file',
  // Capability and isolation: each one hands the CLI back something the
  // adapter deliberately took away.
  '--tools', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools',
  '--permission-mode', '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--setting-sources', '--settings',
  '--add-dir', '--plugin-dir', '--agent', '--agents',
  '--bare', '--continue', '-c', '--resume', '-r',
])

/**
 * Reject `extraArgs` entries that would undo the adapter's own invocation.
 *
 * Matches the flag name alone, so both `--tools default` and `--tools=default`
 * are caught.
 *
 * @param extraArgs - the configured extra arguments.
 * @throws LlmError `UNSUPPORTED` naming every reserved flag that was passed.
 */
export function assertExtraArgsSafe(extraArgs: readonly string[]): void {
  const reserved = extraArgs
    .filter((arg) => arg.startsWith('-'))
    .map((arg) => arg.split('=', 1)[0]!)
    .filter((flag) => RESERVED_FLAGS.has(flag))
  if (reserved.length === 0) return
  throw new LlmError(
    `\`extraArgs\` may not set ${[...new Set(reserved)].join(', ')}.`
    + ' These flags are either assembled by this adapter or would return'
    + ' capability the harness withholds from the CLI. Remove them from the'
    + ' plugin configuration.',
    UNSUPPORTED_CODE,
  )
}

/**
 * Reject request fields the CLI cannot honor.
 * @param options - the assembled request.
 * @param mode - the configured `unsupportedFields` policy.
 * @throws LlmError `UNSUPPORTED` under the `error` policy when a field is set.
 */
function assertSupported(options: GenerateOptions, mode: 'error' | 'ignore'): void {
  if (mode === 'ignore') return
  const set = UNSUPPORTED.filter((field) => options[field] !== undefined)
  if (set.length === 0) return
  throw new LlmError(
    `The Claude CLI has no way to honor ${set.join(', ')}.`
    + ' Remove the field from the agent configuration, or set'
    + ' `unsupportedFields: ignore` on this plugin to drop it instead.',
    UNSUPPORTED_CODE,
  )
}

/** Streams harness model calls through the locally installed Claude Code CLI. */
export class ClaudeCliAdapter extends LlmAdapter {
  readonly #options: AdapterOptions

  constructor(options: AdapterOptions) {
    super()
    // Fail at construction rather than per request: a profile that configures
    // an unsafe `extraArgs` is broken at startup, not on its first model call.
    assertExtraArgsSafe(options.extraArgs)
    this.#options = options
  }

  /**
   * Describe one route this adapter serves.
   * @param provider - a route registered for this instance.
   * @returns display metadata for selectors and diagnostics.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code CLI' }
  }

  /**
   * List the models the CLI is known to accept by name.
   * @param provider - a route registered for this instance.
   * @returns the advisory catalog; unlisted ids remain callable.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(listCatalog(provider))
  }

  /**
   * Resolve metadata for one exact model.
   * @param provider - a route registered for this instance.
   * @param model - the exact model id the request will send to `--model`.
   * @returns identity plus context capacity and reasoning efforts when known.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = contextWindowOf(model)
    const configured = this.#options.defaultEffort
    const defaultEffort = REASONING_EFFORTS.find((effort) => effort.id === configured)?.id
    return Promise.resolve({
      provider,
      id: model,
      name: displayNameOf(model),
      inputModalities: ['text'],
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
      reasoning: {
        efforts: REASONING_EFFORTS,
        ...defaultEffort === undefined ? {} : { defaultEffort },
      },
    })
  }

  /**
   * Build the invocation for one request.
   * @param options - the assembled request.
   * @param manifestPath - path of the tool manifest the bridge will read, when
   *   the request carries tools.
   * @returns executable, arguments, stdin payload, and environment.
   */
  #invocation(options: GenerateOptions, manifestPath: string | undefined): CliInvocation {
    // `extraArgs` goes first and the adapter's own flags last, because the CLI
    // keeps the last occurrence of a repeated flag. Order is the guarantee:
    // even if a reserved flag ever slipped past validation, it could not win.
    const args: string[] = [
      ...this.#options.extraArgs,
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--no-session-persistence',
      // The harness owns the prompt; the CLI's own settings, memory files, and
      // configured MCP servers must not reach the model.
      '--setting-sources', '',
      '--strict-mcp-config',
      '--tools', '',
      // With no tools there is nothing to permit, so the mode only matters if
      // one ever returns. `dontAsk` keeps the run non-interactive without also
      // pre-approving whatever that future tool would do.
      '--permission-mode', 'dontAsk',
      '--model', options.model,
    ]
    if (options.system !== undefined) args.push('--system-prompt', options.system)
    const effort = options.reasoningEffort ?? this.#options.defaultEffort
    if (effort !== undefined) args.push('--effort', effort)
    if (manifestPath !== undefined) {
      args.push('--mcp-config', JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'stdio',
            command: process.execPath,
            args: [BRIDGE_PATH, manifestPath],
          },
        },
      }))
    }

    const turn = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: renderConversation(options.messages) }],
      },
    }
    return {
      executable: this.#options.executable,
      args,
      stdinPayload: `${JSON.stringify(turn)}\n`,
      cwd: this.#options.cwd,
      env: process.env,
    }
  }

  /**
   * Stream one model call through the CLI.
   * @param options - the assembled request; `signal` aborts the process.
   * @returns the harness chunk stream for one model message.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    assertSupported(options, this.#options.unsupportedFields)

    const spec = buildToolBridgeSpec(options.tools ?? [])
    let workDir: string | undefined
    let manifestPath: string | undefined
    if (spec.tools.length > 0) {
      workDir = await mkdtemp(join(tmpdir(), 'dsh-claude-cli-'))
      manifestPath = join(workDir, 'tools.json')
      await writeFile(manifestPath, JSON.stringify(spec.tools), 'utf8')
    }

    const run = runCli(this.#invocation(options, manifestPath), {
      ...options.signal === undefined ? {} : { signal: options.signal },
      idleTimeoutMs: this.#options.streamIdleTimeoutMs,
    })
    try {
      yield* translate(run.lines, { harnessNames: spec.harnessNames, now: () => Date.now() })
    } finally {
      // Reached on the normal early return too: a turn ending in a tool call
      // is complete for the harness while the CLI still intends to continue.
      run.close()
      if (workDir !== undefined) await rm(workDir, { recursive: true, force: true })
    }
  }
}
