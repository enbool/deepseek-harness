/**
 * The HTML→markdown conversion used for topic bodies. A single stateless
 * turndown instance with GitHub-flavored tables and strikethrough, shared
 * across calls; conversion failures surface as a fixed omission marker so raw
 * markup never reaches the model-facing result.
 * @module @deepseek-ai/dsh-tool-tgb/markdown
 */

import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

/**
 * The shared converter. Style options are fixed model-facing presentation,
 * not deployment tunables; the instance is stateless across `turndown` calls.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)

/** The marker returned when a body cannot be converted safely. */
export const OMISSION_MARKER = '[Content omitted: unable to convert safely.]'

/**
 * Convert one HTML fragment (a topic's first-post body) to markdown.
 *
 * @param html - the fragment's inner HTML.
 * @returns the markdown text, or {@link OMISSION_MARKER} when conversion fails.
 */
export function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html)
  } catch {
    // turndown's DOM walk can throw on pathological markup; the fetch itself
    // succeeded, so the topic returns with its metadata and a fixed marker
    // instead of failing whole.
    return OMISSION_MARKER
  }
}
