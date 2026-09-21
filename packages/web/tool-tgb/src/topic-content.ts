/**
 * Parser for a topic detail page (`/a/{code}`): the header's title, author,
 * and counters plus the first-post body (`.p_coten`) converted to markdown.
 * Embedded player and vote scaffolding is dropped before conversion.
 * @module @deepseek-ai/dsh-tool-tgb/topic-content
 */

import { parse } from 'node-html-parser'
import { TGB_PARSE_FAILED, TgbError } from './errors.ts'
import { htmlToMarkdown } from './markdown.ts'
import { cleanText, leadingCount } from './text.ts'
import type { TopicContent } from './types.ts'

/**
 * Parse one topic detail page.
 *
 * @param html - the decoded page HTML.
 * @param code - the `/a/` short code the page was fetched for.
 * @returns the parsed topic content.
 */
export function parseTopicContentPage(html: string, code: string): TopicContent {
  const root = parse(html)
  const titleElement = root.querySelector('.article-tittle')
  if (titleElement === null) {
    throw new TgbError(`topic page for ${code} has no .article-tittle title block`, TGB_PARSE_FAILED)
  }
  const dataElement = root.querySelector('.article-data')
  if (dataElement === null) {
    throw new TgbError(`topic page for ${code} has no .article-data header`, TGB_PARSE_FAILED)
  }
  const dataText = dataElement.text
  const dateMatch = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/u.exec(cleanText(dataText))
  const authorAnchor = dataElement.querySelector('.data-userid a')
  return {
    code,
    url: `https://www.tgb.cn/a/${code}`,
    title: cleanText(titleElement.text),
    author: cleanText(authorAnchor?.text ?? ''),
    authorID: authorAnchor?.getAttribute('data-user-id') ?? '',
    publishDate: dateMatch?.[1] ?? '',
    views: leadingCount(/浏览\s*(\d+)/u.exec(dataText)?.[1] ?? ''),
    replies: leadingCount(/评论\s*(\d+)/u.exec(dataText)?.[1] ?? ''),
    // The 加油 counter renders as `total/month`; the total is its first integer.
    tickets: leadingCount(root.querySelector('.goldUseful')?.text ?? ''),
    contentMarkdown: parseContent(root, code),
  }
}

/**
 * Extract and convert the first-post body, dropping the site's embedded
 * player and vote scaffolding so only authored content converts.
 *
 * @param root - the parsed page.
 * @param code - the short code, for the failure message.
 * @returns the body as markdown.
 */
function parseContent(root: ReturnType<typeof parse>, code: string): string {
  const contentElement = root.querySelector('.p_coten')
  if (contentElement === null) {
    throw new TgbError(`topic page for ${code} has no .p_coten content block`, TGB_PARSE_FAILED)
  }
  contentElement.querySelector('#videoImg')?.remove()
  return htmlToMarkdown(contentElement.innerHTML)
}
