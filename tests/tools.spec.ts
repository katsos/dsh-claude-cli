import { describe, expect, it } from 'vitest'
import { buildToolBridgeSpec, harnessToolName } from '../src/tools.ts'

describe('buildToolBridgeSpec', () => {
  it('passes legal names and JSON Schema through unchanged', () => {
    const spec = buildToolBridgeSpec([
      { name: 'todo_write', description: 'Write todos.', parameters: { type: 'object' } },
    ])

    expect(spec.tools).toEqual([
      { name: 'todo_write', description: 'Write todos.', inputSchema: { type: 'object' } },
    ])
    expect(spec.harnessNames).toEqual({})
  })

  it('rewrites an illegal name and records the way back', () => {
    const spec = buildToolBridgeSpec([
      { name: 'fs.read file', description: 'Read.', parameters: {} },
    ])

    expect(spec.tools[0]?.name).toBe('fs_read_file')
    expect(harnessToolName('mcp__dsh__fs_read_file', spec.harnessNames)).toBe('fs.read file')
  })

  it('keeps rewritten names distinct when two tools collide', () => {
    const spec = buildToolBridgeSpec([
      { name: 'a.b', description: '', parameters: {} },
      { name: 'a/b', description: '', parameters: {} },
    ])

    expect(spec.tools[0]?.name).not.toBe(spec.tools[1]?.name)
    expect(harnessToolName(`mcp__dsh__${spec.tools[1]!.name}`, spec.harnessNames)).toBe('a/b')
  })
})

describe('harnessToolName', () => {
  it('returns undefined for a call that did not address the bridge', () => {
    expect(harnessToolName('Bash', {})).toBeUndefined()
  })
})
