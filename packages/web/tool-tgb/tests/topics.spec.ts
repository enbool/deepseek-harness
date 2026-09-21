/**
 * Parser tests for the topic-list page, over the recorded fixture and inline
 * fragments for the structural-drift and edge branches.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expectTgbError } from './helpers.ts'
import { parseTopicsPage } from '../src/topics.ts'

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/more-topic.html', import.meta.url)), 'utf8')

describe('parseTopicsPage over the recorded fixture', () => {
  const topics = parseTopicsPage(fixture)

  it('parses every data row', () => {
    expect(topics).toHaveLength(4)
  })

  it('parses the first row fields completely', () => {
    expect(topics[0]).toEqual({
      topicID: '2805166',
      code: '1ykHx9mgs4W',
      url: 'https://www.tgb.cn/a/1ykHx9mgs4W',
      title: '大盘走势很标准的背驰，这波反弹应该结束了',
      author: 'enbool',
      authorID: '905478',
      lastReplyTime: '04-19 21:16',
      replies: 0,
      views: 546,
      tickets: 0,
      likes: 2,
      publishDate: '2020-04-19',
    })
  })

  it('parses the last row', () => {
    expect(topics[3]?.title).toBe('@股天乐 金豆莫名其妙的少了好多，几次了')
    expect(topics[3]?.replies).toBe(3)
    expect(topics[3]?.views).toBe(1023)
    expect(topics[3]?.publishDate).toBe('2017-06-15')
  })
})

describe('parseTopicsPage edge branches', () => {
  const row = (cells: string, href = '/a/1ykHx9mgs4W'): string => `<html><body><table class="T1"><tr>
    <td><input name="topicIDList" type="checkbox" value="2805166_905478"/></td>
    <td class="suh"><a href="${href}" title="t">标题</a></td>${cells}</tr></table></body></html>`

  it('returns an empty array for a page with no data rows', () => {
    expect(parseTopicsPage('<html><table class="T1"><tr><th>标 题</th></tr></table></html>')).toEqual([])
  })

  it('fails loud when the checkbox carries no topic id', () => {
    const html = '<html><table class="T1"><tr><td><input name="topicIDList" value=""/></td><td><a href="/a/x">t</a></td></tr></table></html>'
    expectTgbError(() => parseTopicsPage(html), 'TGB_PARSE_FAILED', /no topic id/)
  })

  it('fails loud when the checkbox carries no value attribute', () => {
    const html = '<html><table class="T1"><tr><td><input name="topicIDList"/></td><td><a href="/a/x">t</a></td></tr></table></html>'
    expectTgbError(() => parseTopicsPage(html), 'TGB_PARSE_FAILED', /no topic id/)
  })

  it('fails loud when a row is missing cells', () => {
    expectTgbError(() => parseTopicsPage(row('<td>04-19</td>')), 'TGB_PARSE_FAILED', /has no cell/)
  })

  it('fails loud when the title cell has no /a/ link', () => {
    const html = `<html><table class="T1"><tr>
      <td><input name="topicIDList" value="1_2"/></td>
      <td class="suh">no link here</td>
      ${'<td>x</td>'.repeat(6)}</tr></table></html>`
    expectTgbError(() => parseTopicsPage(html), 'TGB_PARSE_FAILED', /no \/a\/ title link/)
  })

  it('splits the reply/view counter and treats non-numeric text as zero', () => {
    const topics = parseTopicsPage(row('<td>a</td><td>04-19 21:16</td><td>4&nbsp;/&nbsp;604</td><td>0</td><td>2</td><td>2020-02-25</td>'))
    expect(topics[0]?.replies).toBe(4)
    expect(topics[0]?.views).toBe(604)
  })

  it('treats a counter cell without the view half as zero views', () => {
    const topics = parseTopicsPage(row('<td>a</td><td>04-19 21:16</td><td>7</td><td>0</td><td>2</td><td>2020-02-25</td>'))
    expect(topics[0]?.replies).toBe(7)
    expect(topics[0]?.views).toBe(0)
  })
})
