/**
 * Public data types produced by the tgb.cn parsers and returned by the tools.
 * Pure types only — no runtime code. Field shapes mirror what the site's
 * server-rendered pages and JSON endpoints expose; display strings (dates,
 * rates) are passed through verbatim rather than re-parsed into timestamps.
 * @module @deepseek-ai/dsh-tool-tgb/types
 */

/** One topic (主贴) row from a user's topic list page. */
export interface TopicSummary {
  /** Numeric topic id, as embedded in the row checkbox value. */
  topicID: string
  /** Short code used in `/a/{code}` URLs. */
  code: string
  /** Absolute topic URL. */
  url: string
  /** Topic title. */
  title: string
  /** Author display name. */
  author: string
  /** Author user id, when the page embeds one. */
  authorID: string
  /** Latest-reply display time, verbatim (for example `04-19 21:16`). */
  lastReplyTime: string
  /** Reply count. */
  replies: number
  /** View count. */
  views: number
  /** 加油券 count. */
  tickets: number
  /** 赞 count. */
  likes: number
  /** Publish date, verbatim (for example `2020-04-19`). */
  publishDate: string
}

/** One topic's detail page: metadata plus the converted first-post body. */
export interface TopicContent {
  /** Short code used in `/a/{code}` URLs. */
  code: string
  /** Absolute topic URL. */
  url: string
  /** Topic title. */
  title: string
  /** Author display name. */
  author: string
  /** Author user id, when the page embeds one. */
  authorID: string
  /** Publish display time, verbatim (for example `2020-04-19 21:16`). */
  publishDate: string
  /** View count. */
  views: number
  /** Comment count. */
  replies: number
  /** 加油 (gold-useful) count, before the `/month` slash. */
  tickets: number
  /** First-post body converted to markdown. */
  contentMarkdown: string
}

/** One reply (跟帖) entry from a user's reply list page. */
export interface ReplyItem {
  /** Replier display name. */
  userName: string
  /** Reply display time, verbatim (for example `2026-03-30 16:05`). */
  replyTime: string
  /** Source topic short code. */
  sourceCode: string
  /** Absolute source topic URL. */
  sourceUrl: string
  /** Source topic title. */
  sourceTitle: string
  /** Numeric reply id, from the `/a/{code}/{replyId}` anchor. */
  replyId: string
  /** Absolute URL anchoring this exact reply inside its topic. */
  replyUrl: string
  /** Reply body text. */
  content: string
  /** Comment count shown next to the reply. */
  comments: number
  /** 赞 count. */
  likes: number
  /** Source topic author display name. */
  postAuthor: string
  /** Source topic publish date, verbatim. */
  postDate: string
}

/** One followed user from the shuo.tgb.cn follow list. */
export interface FollowUser {
  /** Followed user's id. */
  userID: number
  /** Followed user's display name. */
  userName: string
  /** Portrait path on image.tgb.cn, verbatim. */
  portrait: string
  /** Gender code (`M`/`F`), verbatim. */
  gender: string
  /** Followed user's fan count. */
  fansNum: number
  /** Followed user's follow count. */
  followNum: number
  /** Followed user's 加油 (useful) total. */
  usefulNum: number
  /** Followed user's featured-topic count. */
  bestBBSNums: number
  /** Follow-relationship creation time, verbatim. */
  createDate: string
}

/** One 本周上升达人 (weekly rising star) row from the home page. */
export interface WeekUpStar {
  /** User id from the `/blog/{id}` link. */
  userID: string
  /** Display name. */
  userName: string
  /** Portrait URL. */
  portrait: string
  /** Fan count. */
  fansNum: number
  /** Article count. */
  articleCount: number
  /** 7-day 围观 (viewer) count; 0 when the page omits it. */
  viewers: number
}

/** One 热门研股 (hot research stock) row from the home page. */
export interface HotStock {
  /** Stock code with exchange prefix (for example `sh600448`). */
  code: string
  /** Stock name. */
  name: string
  /** Price/change display text, verbatim (for example `3.68 / +3.95%`). */
  rate: string
  /** 潜伏达人 display text, verbatim (for example `暂无潜伏达人`). */
  diggers: string
}

/** Realtime quote for one stock from the hq.tgb.cn quote endpoint. */
export interface StockQuote {
  /** Stock code with exchange prefix (for example `sh600448`). */
  code: string
  /** Stock name. */
  name: string
  /** Latest price. */
  price: number
  /** Change rate in percent (for example `9.89`). */
  changeRate: number
  /** Quote time, verbatim (for example `14:21:21`). */
  lastTime: string
}

/** The home page's two server-rendered sections. */
export interface HomeSections {
  /** 本周上升达人 rows. */
  weekUpStars: WeekUpStar[]
  /** 热门研股 rows. */
  hotStocks: HotStock[]
}

/** Result of one paginated collection: merged items plus progress facts. */
export interface PageBatch<T> {
  /** Merged items across the fetched pages, in page order. */
  items: T[]
  /** Number of pages actually fetched. */
  pagesFetched: number
  /** Whether the last fetched page still had fresh data left before a stop condition hit. */
  hasMore: boolean
}
