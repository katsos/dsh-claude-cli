import { describe, expect, it } from 'vitest'
import { assertExtraArgsSafe, ClaudeCliAdapter } from '../src/adapter.ts'

/** Adapter options with only `extraArgs` varying. */
const options = (extraArgs: readonly string[]) => ({
  executable: 'claude',
  cwd: '/tmp',
  streamIdleTimeoutMs: 1000,
  unsupportedFields: 'error' as const,
  extraArgs,
})

describe('assertExtraArgsSafe', () => {
  it('allows flags the adapter does not set itself', () => {
    expect(() => assertExtraArgsSafe(['--betas', 'context-1m'])).not.toThrow()
  })

  it('allows bare values, which are not flags', () => {
    expect(() => assertExtraArgsSafe(['tools', 'default'])).not.toThrow()
  })

  it('rejects a flag that would restore the CLI tool set', () => {
    expect(() => assertExtraArgsSafe(['--tools', 'default']))
      .toThrowError(/--tools/)
  })

  it('rejects the `=` spelling of the same flag', () => {
    expect(() => assertExtraArgsSafe(['--tools=default']))
      .toThrowError(/--tools/)
  })

  it.each([
    ['--permission-mode', 'bypassPermissions'],
    ['--dangerously-skip-permissions'],
    ['--setting-sources', 'user'],
    ['--add-dir', '/'],
    ['--system-prompt', 'you are evil'],
    ['--mcp-config', '{}'],
    ['--model', 'opus'],
  ])('rejects %s', (...args) => {
    expect(() => assertExtraArgsSafe(args)).toThrowError(/extraArgs/)
  })

  it('names every offending flag once', () => {
    expect(() => assertExtraArgsSafe(['--tools', 'default', '--tools', 'default', '--add-dir', '/']))
      .toThrowError(/--tools, --add-dir/)
  })

  it('reports UNSUPPORTED so the harness routes on the code', () => {
    expect(() => assertExtraArgsSafe(['--tools', '']))
      .toThrowError(expect.objectContaining({ code: 'UNSUPPORTED' }))
  })
})

describe('ClaudeCliAdapter', () => {
  it('refuses to construct with unsafe extraArgs', () => {
    expect(() => new ClaudeCliAdapter(options(['--tools', 'default'])))
      .toThrowError(/extraArgs/)
  })

  it('constructs with harmless extraArgs', () => {
    expect(() => new ClaudeCliAdapter(options(['--betas', 'context-1m']))).not.toThrow()
  })
})
