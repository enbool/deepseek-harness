/**
 * Text normalization shared by the tgb.cn page parsers: the site renders
 * `&nbsp;` entities, runs separate lines per data cell, and pads cells with
 * whitespace, so every extracted field passes through here once.
 * @module @deepseek-ai/dsh-tool-tgb/text
 */

/**
 * Normalize one extracted text run: non-breaking spaces become plain spaces,
 * runs of whitespace collapse to a single space, and the edges are trimmed.
 *
 * @param input - raw `textContent` from a parsed node.
 * @returns the cleaned display text.
 */
export function cleanText(input: string): string {
  return input.replace(/ /gu, ' ').replace(/\s+/gu, ' ').trim()
}

/**
 * Extract the first integer embedded in a display string (for example
 * `120513粉丝` → `120513`).
 *
 * @param input - raw display text.
 * @returns the first integer found, or 0 when the text carries none.
 */
export function leadingCount(input: string): number {
  const match = /\d+/u.exec(input.replace(/ /gu, ' '))
  return match === null ? 0 : Number.parseInt(match[0], 10)
}

/**
 * Extract the trailing parenthesized integer of a display string (for example
 * `机会就在明天 (6)` → `{ text: '机会就在明天', count: 6 }`).
 *
 * @param input - raw display text, already whitespace-cleaned.
 * @returns the text before the count and the count, or 0 when absent.
 */
export function trailingCount(input: string): { text: string; count: number } {
  const match = /\s*\((\d+)\)\s*$/u.exec(input)
  /* v8 ignore next -- the capture group is not optional, so the second disjunct is defensive typing only. */
  if (match === null || match[1] === undefined) return { text: input, count: 0 }
  return { text: input.slice(0, match.index).trim(), count: Number.parseInt(match[1], 10) }
}
