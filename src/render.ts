/**
 * Rendering of the harness conversation into the single user turn the Claude
 * Code CLI accepts.
 *
 * The CLI owns a conversation of its own, but the harness is the source of
 * truth for history: it compacts, edits, and replays messages the CLI never
 * sees. Each request therefore renders the harness history into one turn and
 * runs a fresh CLI process, so the model's view always equals the harness log.
 * The cost is that no prompt-cache prefix survives between turns; the benefit
 * is that no divergence between two transcripts is possible.
 *
 * Tool calls and results are rendered as text because they belong to turns the
 * CLI process did not take part in. Only the tool call the model makes *now*
 * is native, arriving through the tool bridge as a real `tool_use` block.
 *
 * @module dsh-claude-cli/render
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Text substituted for an image block, which the CLI has no way to accept. */
export const IMAGE_PLACEHOLDER = '[image omitted: the claude-cli provider cannot send images]'

/**
 * Escape the delimiters this renderer uses for structure.
 *
 * Message text is model output and user input, so it may legitimately contain
 * the same angle brackets the transcript frame uses. Escaping them keeps a
 * message from forging a frame boundary.
 *
 * @param text - arbitrary message text.
 * @returns the text with `&`, `<`, and `>` replaced by entities.
 */
function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Render one message's blocks into transcript lines.
 * @param blocks - the message's content blocks, in model-facing order.
 * @returns rendered lines, omitting blocks that carry no transcript meaning.
 */
function renderBlocks(blocks: readonly ContentBlock[]): string[] {
  const lines: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) lines.push(escapeText(block.text))
        break
      case 'tool-call':
        lines.push(
          `<tool-call id="${escapeText(block.id)}" name="${escapeText(block.name)}">`
          + `${escapeText(block.arguments)}</tool-call>`,
        )
        break
      case 'tool-result': {
        const inner = renderBlocks(block.content).join('\n')
        lines.push(
          `<tool-result id="${escapeText(block.toolCallId)}"`
          + `${block.isError ? ' error="true"' : ''}>\n${inner}\n</tool-result>`,
        )
        break
      }
      case 'image':
        lines.push(IMAGE_PLACEHOLDER)
        break
      case 'reasoning':
        // Prior thinking is deliberately dropped: the provider discards
        // unsigned thinking from history, so replaying it as plain text would
        // only spend context on text the model must not treat as its own.
        break
      default:
        // Merge-extensible union: a block type added by another plugin has no
        // rendering this adapter can invent, so it contributes nothing.
        break
    }
  }
  return lines
}

/**
 * Render harness history into the text of one CLI user turn.
 *
 * A conversation whose only message is plain user text renders as that text
 * alone, so the common single-turn case reaches the model unframed.
 *
 * @param messages - the request's ordered messages, after the system slot.
 * @returns the user-turn text; empty only when every message rendered empty.
 */
export function renderConversation(messages: readonly Message[]): string {
  if (messages.length === 1) {
    const only = messages[0]!
    if (only.role === 'user' && only.content.every((block) => block.type === 'text')) {
      return only.content.map((block) => block.type === 'text' ? block.text : '').join('\n')
    }
  }

  const parts: string[] = []
  for (const message of messages) {
    const lines = renderBlocks(message.content)
    if (lines.length === 0) continue
    const tag = message.role === 'assistant' ? 'assistant' : 'user'
    parts.push(`<${tag}>\n${lines.join('\n')}\n</${tag}>`)
  }
  if (parts.length === 0) return ''
  return [
    'Continue this conversation. The transcript below is the complete history;'
    + ' respond only as the final assistant turn.',
    '',
    '<transcript>',
    ...parts,
    '</transcript>',
  ].join('\n')
}
