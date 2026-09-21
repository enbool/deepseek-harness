/**
 * Parser tests for the reply-list page, over the recorded fixture and inline
 * fragments for the structural-drift branches.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRepliesPage } from '../src/replies.ts'

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/more-replies.html', import.meta.url)), 'utf8')

describe('parseRepliesPage over the recorded fixture', () => {
  const replies = parseRepliesPage(fixture)

  it('parses every reply block', () => {
    expect(replies.length).toBeGreaterThan(5)
  })

  it('parses the first reply completely', () => {
    expect(replies[0]).toEqual({
      userName: 'enbool',
      replyTime: '2026-03-30 16:05',
      sourceCode: '2k5fgcbtVDC',
      sourceUrl: 'https://www.tgb.cn/a/2k5fgcbtVDC',
      sourceTitle: '500万实盘，不到1亿不封贴',
      replyId: '97158806',
      replyUrl: 'https://www.tgb.cn/a/2k5fgcbtVDC/97158806#97158806',
      content: '机会就在明天',
      comments: 6,
      likes: 0,
      postAuthor: '作手奇衡三',
      postDate: '2025-07-30',
    })
  })
})

describe('parseRepliesPage edge branches', () => {
  it('returns an empty array for a page with no replies', () => {
    expect(parseRepliesPage('<html><body><div id="wrap_container"></div></body></html>')).toEqual([])
  })

  it('fills absent optional facts with empty defaults', () => {
    const html = '<html><body><div class="blogReply-left left"><div class="blogReply-bot"><div class="clear"></div></div></div></body></html>'
    const replies = parseRepliesPage(html)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({
      userName: '',
      replyTime: '',
      sourceCode: '',
      sourceUrl: '',
      sourceTitle: '',
      replyId: '',
      replyUrl: '',
      content: '',
      comments: 0,
      likes: 0,
      postAuthor: '',
      postDate: '',
    })
  })

  it('keeps a reply anchor without a reply id segment', () => {
    const html = '<html><body><div class="blogReply-left left">'
      + '<a href="/a/2k5fgcbtVDC#frag" class="blogReply-subinfo">内容 (2)</a>'
      + '</div></body></html>'
    const replies = parseRepliesPage(html)
    expect(replies[0]?.replyId).toBe('')
    expect(replies[0]?.replyUrl).toBe('https://www.tgb.cn/a/2k5fgcbtVDC#frag')
    expect(replies[0]?.content).toBe('内容')
    expect(replies[0]?.comments).toBe(2)
  })
})
