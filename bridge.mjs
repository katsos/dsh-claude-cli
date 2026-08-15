/**
 * Stdio MCP server that declares the harness's tools to the Claude Code CLI.
 *
 * Launched by the CLI, not by the harness. It reads a tool manifest written by
 * the adapter (path in `argv[2]`) and serves it over MCP. Calls are never
 * executed here: the harness owns tool execution, and the adapter ends the
 * request as soon as the model's message ends, so a dispatched call normally
 * finds this process already gone. The sentinel result exists only for the
 * race where it does not.
 *
 * Plain JavaScript on purpose — the CLI spawns it with bare `node`, which is
 * not running the harness's TypeScript loader.
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** Result returned if the CLI manages to dispatch a call before teardown. */
const SENTINEL = 'This call was handed to the harness, which owns execution. Stop and wait.'

const manifestPath = process.argv[2]
if (manifestPath === undefined) {
  process.stderr.write('dsh-claude-cli bridge: missing tool manifest path\n')
  process.exit(2)
}

/** @type {{name: string, description: string, inputSchema: Record<string, unknown>}[]} */
const tools = JSON.parse(readFileSync(manifestPath, 'utf8'))

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim().length === 0) return

  let request
  try {
    request = JSON.parse(line)
  } catch {
    // A malformed frame from the CLI is unanswerable: without an id there is
    // no response to correlate, and nothing else here can observe it.
    return
  }

  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh', version: '1.0.0' },
        },
      })
      return
    case 'tools/list':
      send({ jsonrpc: '2.0', id: request.id, result: { tools } })
      return
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: SENTINEL }] },
      })
      return
    default:
      // Notifications (`notifications/initialized`) carry no id and need no
      // reply; anything else with an id gets the standard unknown-method error.
      if (request.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })
      }
  }
})
