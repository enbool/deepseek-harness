/**
 * Parser tests for the home page sections and the realtime quote endpoint,
 * over the recorded fixtures and inline payloads for the invalid-shape branches.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseHomePage, parseQuotesPage } from '../src/home.ts'
import { expectTgbError } from './helpers.ts'

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/home.html', import.meta.url)), 'utf8')

describe('parseHomePage over the recorded fixture', () => {
  const sections = parseHomePage(fixture)

  it('parses the weekly rising stars', () => {
    expect(sections.weekUpStars.length).toBeGreaterThanOrEqual(10)
    expect(sections.weekUpStars[0]).toEqual({
      userID: '5894557',
      userName: '延边刺客',
      portrait: 'https://image.tgb.cn/img/2025/09/13/f89sdtxe5mlk.jpg_80wh.png',
      fansNum: 120513,
      articleCount: 1468,
      viewers: 106,
    })
  })

  it('parses the hot research stocks', () => {
    expect(sections.hotStocks).toHaveLength(5)
    expect(sections.hotStocks[0]).toEqual({
      code: 'sh600448',
      name: '华纺股份',
      rate: '3.68 / +3.95%',
      diggers: '暂无潜伏达人',
    })
  })
})

describe('parseHomePage invalid shapes', () => {
  it('fails loud when a week-up item carries no profile link', () => {
    expectTgbError(
      () => parseHomePage('<html><body><div class="defaultContainerRight-weekUp-item">no link</div></body></html>'),
      'TGB_PARSE_FAILED',
      /no \/blog\/ profile link/,
    )
  })

  it('fails loud when a stock input has no adjacent card', () => {
    expectTgbError(
      () => parseHomePage('<html><body><input type="hidden" name="code_input" value="sh600448"/></body></html>'),
      'TGB_PARSE_FAILED',
      /no adjacent stock card/,
    )
  })

  it('fails loud when a stock input carries no code', () => {
    expectTgbError(
      () => parseHomePage('<html><body><input type="hidden" name="code_input"/><div class="defaultContainerRight-stock-item"></div></body></html>'),
      'TGB_PARSE_FAILED',
      /for "" has no adjacent/,
    )
  })

  it('fills absent star and stock facts with empty defaults', () => {
    const html = '<html><body>'
      + '<div class="defaultContainerRight-weekUp-item"><a href="/blog/42?sy_dr"></a></div>'
      + '<input type="hidden" name="code_input" value="sh600448"/>'
      + '<div class="defaultContainerRight-stock-item" id="sh600448"></div>'
      + '</body></html>'
    const sections = parseHomePage(html)
    expect(sections.weekUpStars).toEqual([{ userID: '42', userName: '', portrait: '', fansNum: 0, articleCount: 0, viewers: 0 }])
    expect(sections.hotStocks).toEqual([{ code: 'sh600448', name: '', rate: '', diggers: '' }])
  })
})

describe('parseQuotesPage', () => {
  const answer = {
    status: true,
    dto: [
      { fullCode: 'sz001216', name: '华瓷股份', price: 24.06, pxChangeRate: 10.01, lastTime: '14:21:21' },
      { fullCode: 'sh600448', name: '华纺股份', price: 3.89, pxChangeRate: 9.89, lastTime: '14:21:21' },
    ],
  }

  it('parses quotes in request order, skipping unanswered codes', () => {
    expect(parseQuotesPage(answer, ['sh600448', 'sz999999', 'sz001216'])).toEqual([
      { code: 'sh600448', name: '华纺股份', price: 3.89, changeRate: 9.89, lastTime: '14:21:21' },
      { code: 'sz001216', name: '华瓷股份', price: 24.06, changeRate: 10.01, lastTime: '14:21:21' },
    ])
  })

  it('fails loud on shapes it cannot trust', () => {
    expectTgbError(() => parseQuotesPage('nope', []), 'TGB_UPSTREAM_INVALID', /not an object/)
    expectTgbError(() => parseQuotesPage({ status: true }, []), 'TGB_UPSTREAM_INVALID', /no dto array/)
    expectTgbError(() => parseQuotesPage({ status: true, dto: [null] }, []), 'TGB_UPSTREAM_INVALID', /entry 0/)
    expectTgbError(() => parseQuotesPage({ status: true, dto: [{ fullCode: 'sh1' }] }, []), 'TGB_UPSTREAM_INVALID', /usable code/)
    expectTgbError(() => parseQuotesPage({ status: true, dto: [{ name: 'x', price: 1, pxChangeRate: 1 }] }, []), 'TGB_UPSTREAM_INVALID', /usable code/)
  })

  it('fills absent name and quote-time facts with empty defaults', () => {
    const quotes = parseQuotesPage({ status: true, dto: [{ fullCode: 'sh600448', price: 3.89, pxChangeRate: 9.89 }] }, ['sh600448'])
    expect(quotes).toEqual([{ code: 'sh600448', name: '', price: 3.89, changeRate: 9.89, lastTime: '' }])
  })
})
