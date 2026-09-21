/**
 * Parser for a user's reply-list page (跟帖). Each entry is one
 * `div.blogReply-left` block: replier name and time, the source topic link,
 * the reply body anchor (`/a/{code}/{replyId}`) with its comment count, and
 * the source post's author and date.
 * @module @deepseek-ai/dsh-tool-tgb/replies
 */

import { parse, type HTMLElement } from 'node-html-parser'
import { cleanText, leadingCount, trailingCount } from './text.ts'
import type { ReplyItem } from './types.ts'

/**
 * Parse one reply-list page into its reply entries, in page order.
 *
 * @param html - the decoded page HTML.
 * @returns the parsed replies; an empty array when the page lists none.
 */
export function parseRepliesPage(html: string): ReplyItem[] {
  return parse(html).querySelectorAll('div.blogReply-left').map(parseReplyBlock)
}

/**
 * Parse one reply block.
 *
 * @param block - a `div.blogReply-left` element.
 * @returns the parsed reply item.
 */
function parseReplyBlock(block: HTMLElement): ReplyItem {
  const sourceAnchor = block.querySelector('.blogReply-from a[href^="/a/"]')
  const subInfo = block.querySelector('a.blogReply-subinfo')
  const sourceHref = sourceAnchor?.getAttribute('href') ?? ''
  const sourceCode = sourceHref.startsWith('/a/') ? sourceHref.slice(3) : ''
  const replyHref = subInfo?.getAttribute('href') ?? ''
  /* v8 ignore next -- split() always yields a first element; the index narrowing is defensive typing only. */
  const replySegments = (replyHref.split('#')[0] ?? '').split('/').filter(segment => segment.length > 0)
  const content = trailingCount(cleanText(subInfo?.text ?? ''))
  // `.blogReply-post` renders as `<author> 发布于 <date>`; the separator is fixed.
  const [postAuthor = '', postDate = ''] = cleanText(block.querySelector('.blogReply-post')?.text ?? '').split(/\s*发布于\s*/u)
  return {
    userName: cleanText(block.querySelector('.blogReply-userName')?.text ?? ''),
    replyTime: cleanText(block.querySelector('.blogReply-date')?.text ?? ''),
    sourceCode,
    sourceUrl: sourceCode === '' ? '' : `https://www.tgb.cn/a/${sourceCode}`,
    sourceTitle: cleanText(sourceAnchor?.getAttribute('title') ?? ''),
    replyId: replySegments[2] ?? '',
    replyUrl: replyHref === '' ? '' : `https://www.tgb.cn${replyHref}`,
    content: content.text,
    comments: content.count,
    likes: leadingCount(block.querySelector('.zanNums')?.text ?? ''),
    postAuthor,
    postDate: postDate.trim(),
  }
}
