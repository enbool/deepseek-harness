/**
 * Parser for the home page's two server-rendered sections: 本周上升达人
 * (weekly rising stars) and 热门研股 (hot research stocks). Structural drift
 * fails loud with `TGB_PARSE_FAILED`.
 * @module @deepseek-ai/dsh-tool-tgb/home
 */

import { parse, type HTMLElement } from 'node-html-parser'
import { TGB_PARSE_FAILED, TGB_UPSTREAM_INVALID, TgbError } from './errors.ts'
import { cleanText, leadingCount } from './text.ts'
import type { HomeSections, HotStock, StockQuote, WeekUpStar } from './types.ts'

/**
 * Parse the home page's two sections.
 *
 * @param html - the decoded home page HTML.
 * @returns the rising stars and hot stocks, in page order.
 */
export function parseHomePage(html: string): HomeSections {
  const root = parse(html)
  return {
    weekUpStars: root.querySelectorAll('.defaultContainerRight-weekUp-item').map(parseWeekUpItem),
    hotStocks: root.querySelectorAll('input[name="code_input"]').map(parseHotStock),
  }
}

/**
 * Parse one 本周上升达人 row.
 *
 * @param item - the row element.
 * @returns the parsed rising star.
 */
function parseWeekUpItem(item: HTMLElement): WeekUpStar {
  const profileAnchor = item.querySelector('a[href^="/blog/"]')
  const profilePath = profileAnchor?.getAttribute('href') ?? ''
  /* v8 ignore next -- split() always yields a first element; the index narrowing is defensive typing only. */
  const userID = (profilePath.split('?')[0] ?? '').split('/').pop() ?? ''
  if (userID === '') {
    throw new TgbError('home page week-up item carries no /blog/ profile link', TGB_PARSE_FAILED)
  }
  const summary = cleanText(item.querySelector('.defaultContainerRight-weekUp-7weiguan')?.text ?? '')
  return {
    userID,
    userName: cleanText(item.querySelector('.defaultContainerRight-weekUp-userName')?.text ?? ''),
    portrait: cleanText(item.querySelector('img.img1')?.getAttribute('src') ?? ''),
    fansNum: leadingCount(item.querySelector('.defaultContainerRight-weekUp-fensi')?.text ?? ''),
    articleCount: leadingCount(/(\d+)\s*篇文章/u.exec(summary)?.[1] ?? ''),
    viewers: leadingCount(/(\d+)\s*人围观/u.exec(summary)?.[1] ?? ''),
  }
}

/**
 * Parse one 热门研股 row from its `code_input` hidden input; the row's
 * visible card is the input's next element sibling.
 *
 * @param input - the `code_input` hidden input element.
 * @returns the parsed hot stock.
 */
function parseHotStock(input: HTMLElement): HotStock {
  const code = input.getAttribute('value') ?? ''
  const card = input.nextElementSibling
  if (code === '' || card === null || !card.getAttribute('class')?.includes('defaultContainerRight-stock-item')) {
    throw new TgbError(`home page hot-stock row for "${code}" has no adjacent stock card`, TGB_PARSE_FAILED)
  }
  return {
    code,
    name: cleanText(card.querySelector('.defaultContainerRight-stock-name p')?.text ?? ''),
    rate: cleanText(card.querySelector('.defaultContainerRight-stock-Rate')?.text ?? ''),
    diggers: cleanText(card.querySelector('.defaultContainerRight-stock-7discuss')?.text ?? ''),
  }
}

/**
 * Parse the `realHQList` answer into one quote per requested stock, in the
 * requested order; codes the endpoint did not answer are skipped.
 *
 * @param payload - the parsed JSON answer.
 * @param codes - the requested stock codes, in request order.
 * @returns the parsed quotes.
 */
export function parseQuotesPage(payload: unknown, codes: readonly string[]): StockQuote[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new TgbError('tgb.cn quote answer is not an object', TGB_UPSTREAM_INVALID)
  }
  const dto = (payload as Record<string, unknown>).dto
  if (!Array.isArray(dto)) {
    throw new TgbError('tgb.cn quote answer carries no dto array', TGB_UPSTREAM_INVALID)
  }
  const byCode = new Map<string, StockQuote>()
  for (const [index, entry] of dto.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new TgbError(`tgb.cn quote entry ${index} is not an object`, TGB_UPSTREAM_INVALID)
    }
    const record = entry as Record<string, unknown>
    const code = typeof record.fullCode === 'string' ? record.fullCode : ''
    const price = typeof record.price === 'number' ? record.price : Number.NaN
    const changeRate = typeof record.pxChangeRate === 'number' ? record.pxChangeRate : Number.NaN
    if (code === '' || Number.isNaN(price) || Number.isNaN(changeRate)) {
      throw new TgbError(`tgb.cn quote entry ${index} carries no usable code/price/changeRate`, TGB_UPSTREAM_INVALID)
    }
    byCode.set(code, {
      code,
      name: typeof record.name === 'string' ? record.name : '',
      price,
      changeRate,
      lastTime: typeof record.lastTime === 'string' ? record.lastTime : '',
    })
  }
  return codes.flatMap((code) => {
    const quote = byCode.get(code)
    return quote === undefined ? [] : [quote]
  })
}
