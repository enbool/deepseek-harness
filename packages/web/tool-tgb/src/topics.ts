/**
 * Parser for a user's topic-list page (主贴列表). The page is one server-rendered
 * table (`table.T1`); every data row carries a `topicIDList` checkbox whose
 * value is `{topicID}_{userID}` plus the title, author, counters, and dates in
 * fixed columns. Structural drift fails loud with `TGB_PARSE_FAILED`.
 * @module @deepseek-ai/dsh-tool-tgb/topics
 */

import { parse, type HTMLElement } from 'node-html-parser'
import { TGB_PARSE_FAILED, TgbError } from './errors.ts'
import { cleanText, leadingCount } from './text.ts'
import type { TopicSummary } from './types.ts'

/**
 * Parse one topic-list page into its topic rows, in page order.
 *
 * @param html - the decoded page HTML.
 * @returns the parsed topic summaries; an empty array when the page lists none.
 */
export function parseTopicsPage(html: string): TopicSummary[] {
  const rows = parse(html)
    .querySelectorAll('table.T1 tr')
    .filter(row => row.querySelector('input[name="topicIDList"]') !== null)
  return rows.map(parseTopicRow)
}

/**
 * Parse one table row into a topic summary.
 *
 * @param row - a row carrying the `topicIDList` checkbox.
 * @returns the parsed summary.
 */
function parseTopicRow(row: HTMLElement): TopicSummary {
  const checkbox = row.querySelector('input[name="topicIDList"]')
  const checkboxValue = checkbox?.getAttribute('value') ?? ''
  const [topicID = '', userID = ''] = checkboxValue.split('_')
  if (topicID === '') {
    throw new TgbError('topic row checkbox carried no topic id', TGB_PARSE_FAILED)
  }
  const cells = row.querySelectorAll('td')
  const cellAt = (index: number): HTMLElement => {
    const cell = cells[index]
    if (cell === undefined) {
      throw new TgbError(`topic row for ${topicID} has no cell ${index}`, TGB_PARSE_FAILED)
    }
    return cell
  }
  const anchor = cellAt(1).querySelector('a[href^="/a/"]')
  const href = anchor?.getAttribute('href') ?? ''
  const code = href.startsWith('/a/') ? href.slice(3) : ''
  if (anchor === null || code === '') {
    throw new TgbError(`topic row for ${topicID} carries no /a/ title link`, TGB_PARSE_FAILED)
  }
  const counts = cleanText(cellAt(4).text).split('/')
  /* v8 ignore next -- split() always yields a first element; the index narrowing is defensive typing only. */
  const repliesText = counts[0] ?? ''
  const viewsText = counts[1] ?? ''
  return {
    topicID,
    code,
    url: `https://www.tgb.cn/a/${code}`,
    title: cleanText(anchor.text),
    author: cleanText(cellAt(2).text),
    authorID: userID,
    lastReplyTime: cleanText(cellAt(3).text),
    replies: leadingCount(repliesText),
    views: leadingCount(viewsText),
    tickets: leadingCount(cellAt(5).text),
    likes: leadingCount(cellAt(6).text),
    publishDate: cleanText(cellAt(7).text),
  }
}
