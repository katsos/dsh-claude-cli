/**
 * Presentation of harness tool schemas to the CLI as an MCP server, and
 * recovery of harness tool names from the wire names the model produces.
 *
 * The CLI has no flag for "here are the tools, hand their calls back to me".
 * It does have MCP, so this adapter declares the harness's tools through a
 * bridge server the CLI launches. The model then emits real `tool_use` blocks
 * with provider-validated arguments, which is the whole reason for the
 * indirection: no prompt-level tool-call convention could match it.
 *
 * The bridge never executes anything. The harness owns execution, and the
 * adapter ends the stream as soon as the model's message does, so the CLI is
 * gone before a call could be dispatched.
 *
 * @module dsh-claude-cli/tools
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** MCP server name the bridge registers under; fixes the model-visible tool prefix. */
export const MCP_SERVER_NAME = 'dsh'

/** Prefix the CLI prepends to every tool served by {@link MCP_SERVER_NAME}. */
export const TOOL_NAME_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** Provider bound on a whole tool name, which the prefix eats into. */
const MAX_WIRE_NAME_LENGTH = 128

/** Characters a provider tool name may contain. */
const INVALID_NAME_CHARS = /[^a-zA-Z0-9_-]/g

/** One harness tool as the bridge serves it. */
export interface BridgeTool {
  /** Prefix-free name; the model sees it as `mcp__dsh__<name>`. */
  name: string
  description: string
  /** JSON Schema for the arguments, passed through unchanged. */
  inputSchema: Record<string, unknown>
}

/** Tools as the bridge serves them, plus the map back to harness names. */
export interface ToolBridgeSpec {
  tools: BridgeTool[]
  /** Bridge name to harness name, for every tool whose name was rewritten. */
  harnessNames: Record<string, string>
}

/**
 * Adapt harness tool schemas for the bridge.
 *
 * A harness tool name is normally already a legal provider tool name and
 * passes through untouched. One that is not is rewritten and recorded, so the
 * harness name can be restored from the model's call.
 *
 * @param schemas - the request's tool schemas.
 * @returns the bridge's tool list and the reverse name map.
 */
export function buildToolBridgeSpec(schemas: readonly ToolSchema[]): ToolBridgeSpec {
  const budget = MAX_WIRE_NAME_LENGTH - TOOL_NAME_PREFIX.length
  const tools: BridgeTool[] = []
  const harnessNames: Record<string, string> = {}
  const taken = new Set<string>()

  for (const schema of schemas) {
    let name = schema.name.replace(INVALID_NAME_CHARS, '_').slice(0, budget)
    if (name.length === 0) name = 'tool'
    if (taken.has(name)) {
      let suffix = 2
      while (taken.has(`${name.slice(0, budget - 3)}_${suffix}`)) suffix += 1
      name = `${name.slice(0, budget - 3)}_${suffix}`
    }
    taken.add(name)
    if (name !== schema.name) harnessNames[name] = schema.name
    tools.push({ name, description: schema.description, inputSchema: schema.parameters })
  }

  return { tools, harnessNames }
}

/**
 * Recover the harness tool name from a name the model called.
 * @param wireName - the `name` on a `tool_use` block.
 * @param harnessNames - the reverse map from {@link buildToolBridgeSpec}.
 * @returns the harness tool name, or undefined when the call did not address
 *   the bridge (the CLI's own tools are disabled, so this means a stray call).
 */
export function harnessToolName(
  wireName: string,
  harnessNames: Readonly<Record<string, string>>,
): string | undefined {
  if (!wireName.startsWith(TOOL_NAME_PREFIX)) return undefined
  const bridgeName = wireName.slice(TOOL_NAME_PREFIX.length)
  return harnessNames[bridgeName] ?? bridgeName
}
