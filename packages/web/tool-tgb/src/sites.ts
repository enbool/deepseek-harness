/**
 * The tgb.cn origins this plugin talks to and the URL builders for every page
 * and endpoint it fetches. The origins are the site's external specification
 * (fixed, not deployment tunables); every URL is built here from validated
 * numeric ids and short codes, so no model-supplied URL ever reaches fetch.
 * @module @deepseek-ai/dsh-tool-tgb/sites
 */

/** The main site origin: blog pages, topic pages, and the home page. */
export const WWW_ORIGIN = 'https://www.tgb.cn'

/** The shuo sub-site origin: the follow-list JSON endpoint and login state. */
export const SHUO_ORIGIN = 'https://shuo.tgb.cn'

/** The quotes sub-site origin: realtime stock quotes for the home page's hot stocks. */
export const HQ_ORIGIN = 'https://hq.tgb.cn'

/**
 * Build one page of a user's topic list (主贴列表).
 *
 * @param userID - numeric user id.
 * @param pageNo - 1-based page number.
 * @param sortFlag - optional sort flag; the site's `R` sorts by latest reply.
 * @returns the page URL.
 */
export function moreTopicUrl(userID: number, pageNo: number, sortFlag?: string): URL {
  const url = new URL('/user/blog/moreTopic', WWW_ORIGIN)
  url.searchParams.set('userID', String(userID))
  url.searchParams.set('pageNo', String(pageNo))
  if (sortFlag !== undefined) url.searchParams.set('sortFlag', sortFlag)
  return url
}

/**
 * Build one topic detail page URL from its short code.
 *
 * @param code - the `/a/` short code (letters and digits only).
 * @returns the topic URL.
 */
export function topicUrl(code: string): URL {
  return new URL(`/a/${encodeURIComponent(code)}`, WWW_ORIGIN)
}

/**
 * Build one page of a user's reply list (跟帖).
 *
 * @param userID - numeric user id.
 * @param pageNo - 1-based page number.
 * @param time - optional date filter (`YYYY-MM-DD`); omitted means all dates.
 * @returns the page URL.
 */
export function moreRepliesUrl(userID: number, pageNo: number, time?: string): URL {
  const url = new URL('/user/blog/moreReplyMod', WWW_ORIGIN)
  url.searchParams.set('userID', String(userID))
  url.searchParams.set('pageNo', String(pageNo))
  if (time !== undefined) url.searchParams.set('time', time)
  return url
}

/**
 * Build the current-login-state endpoint URL.
 *
 * @returns the `getIsLogin` URL.
 */
export function isLoginUrl(): URL {
  return new URL('/user/getIsLogin', WWW_ORIGIN)
}

/**
 * Build one page of a user's follow list (关注列表) on the shuo sub-site.
 *
 * @param userID - numeric user id.
 * @param pageNo - 1-based page number.
 * @returns the follow-list URL.
 */
export function followsUrl(userID: number, pageNo: number): URL {
  const url = new URL('/shuo/getUserBlogShuoFollow', SHUO_ORIGIN)
  url.searchParams.set('userID', String(userID))
  url.searchParams.set('pageNo', String(pageNo))
  return url
}

/**
 * Build the home page URL holding the 本周上升达人 and 热门研股 sections.
 *
 * @returns the home page URL.
 */
export function homeUrl(): URL {
  return new URL('/', WWW_ORIGIN)
}

/**
 * Build the realtime-quote endpoint URL for a set of stock codes. The site's
 * contract requires the code list JSON-encoded into the query string.
 *
 * @param codes - stock codes with exchange prefix (for example `sh600448`).
 * @returns the quote endpoint URL.
 */
export function realHQUrl(codes: readonly string[]): URL {
  const url = new URL('/tgb/realHQList', HQ_ORIGIN)
  url.searchParams.set('stockCodeList', JSON.stringify(codes))
  return url
}
