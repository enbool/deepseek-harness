/**
 * Parser tests for the topic-content page, over the recorded fixture and
 * inline fragments for the structural-drift branches.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import TurndownService from 'turndown'
import { OMISSION_MARKER } from '../src/markdown.ts'
import { parseTopicContentPage } from '../src/topic-content.ts'
import { expectTgbError } from './helpers.ts'

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/topic-content.html', import.meta.url)), 'utf8')

describe('parseTopicContentPage over the recorded fixture', () => {
  const content = parseTopicContentPage(fixture, '1ykHx9mgs4W')

  it('parses the header metadata', () => {
    expect(content.code).toBe('1ykHx9mgs4W')
    expect(content.url).toBe('https://www.tgb.cn/a/1ykHx9mgs4W')
    expect(content.title).toBe('大盘走势很标准的背驰，这波反弹应该结束了')
    expect(content.author).toBe('enbool')
    expect(content.authorID).toBe('905478')
    expect(content.publishDate).toBe('2020-04-19 21:16')
    expect(content.views).toBe(544)
    expect(content.replies).toBe(0)
    expect(content.tickets).toBe(0)
  })

  it('converts the body to markdown without the player scaffolding', () => {
    expect(content.contentMarkdown).toContain('管住手')
  })
})

describe('parseTopicContentPage edge branches', () => {
  it('fails loud when the title block is missing', () => {
    expectTgbError(() => parseTopicContentPage('<html><body></body></html>', 'x'), 'TGB_PARSE_FAILED', /no \.article-tittle/)
  })

  it('fails loud when the data header is missing', () => {
    expectTgbError(
      () => parseTopicContentPage('<html><body><div class="article-tittle">t</div></body></html>', 'x'),
      'TGB_PARSE_FAILED',
      /no \.article-data/,
    )
  })

  it('fails loud when the content block is missing', () => {
    const html = '<html><body><div class="article-tittle">t</div><div class="article-data">浏览 1 评论 2</div></body></html>'
    expectTgbError(() => parseTopicContentPage(html, 'x'), 'TGB_PARSE_FAILED', /no \.p_coten/)
  })

  it('omits the body with the fixed marker when turndown throws', () => {
    const spy = vi.spyOn(TurndownService.prototype, 'turndown').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded')
    })
    try {
      const html = '<html><body><div class="article-tittle">t</div>'
        + '<div class="article-data">2020-04-19 21:16 浏览 1 评论 2</div>'
        + '<div class="p_coten">body</div></body></html>'
      const content = parseTopicContentPage(html, 'x')
      expect(content.contentMarkdown).toBe(OMISSION_MARKER)
    } finally {
      spy.mockRestore()
    }
  })

  it('fills absent counters and author facts with empty/zero defaults', () => {
    const html = '<html><body><div class="article-tittle">t</div>'
      + '<div class="article-data">no counters here</div>'
      + '<div class="p_coten">body</div></body></html>'
    const content = parseTopicContentPage(html, 'x')
    expect(content.author).toBe('')
    expect(content.authorID).toBe('')
    expect(content.publishDate).toBe('')
    expect(content.views).toBe(0)
    expect(content.replies).toBe(0)
    expect(content.tickets).toBe(0)
  })

  it('reads the加油 total from the goldUseful counter', () => {
    const html = '<html><body><div class="article-tittle">t</div>'
      + '<div class="article-data">2020-04-19 21:16 浏览 1 评论 2</div>'
      + '<span class="goldUseful">12/3</span>'
      + '<div class="p_coten">body</div></body></html>'
    expect(parseTopicContentPage(html, 'x').tickets).toBe(12)
  })
})
