/**
 * The five model-facing tgb.cn tools. This module owns the model-facing
 * schemas, argument validation beyond the DSL, rendering, and pagination
 * bounds; the HTTP client and page parsers stay out of the model contract.
 * Every tool is read-only over the site, so all are concurrency-safe, and
 * every execute forwards the caller's cancellation signal.
 * @module @deepseek-ai/dsh-tool-tgb/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TgbClient } from './client.ts'
import { parseFollowsPage, parseLoginState } from './follows.ts'
import { parseHomePage, parseQuotesPage } from './home.ts'
import { isLoginUrl, followsUrl, homeUrl, moreRepliesUrl, moreTopicUrl, realHQUrl, topicUrl } from './sites.ts'
import { parseRepliesPage } from './replies.ts'
import { parseTopicContentPage } from './topic-content.ts'
import { parseTopicsPage } from './topics.ts'
import type { FollowUser, HomeSections, ReplyItem, StockQuote, TopicContent, TopicSummary } from './types.ts'

/** Deployment-owned bounds the tools render and paginate under. */
export interface ToolLimits {
  /** Default page budget for one paginated call. */
  readonly maxPages: number
  /** Cooperative tool-call timeout budget (ms), attached to each tool. */
  readonly timeoutMs: number
  /** Cap on one complete rendered tool output. */
  readonly maxOutputChars: number
}

/** The `tgb_get_topics` canonical output value. */
export interface TopicsValue {
  /** The queried user id. */
  userID: number
  /** The 1-based page the collection started at. */
  pageNo: number
  /** Pages actually fetched. */
  pagesFetched: number
  /** Whether fresh data remained when the budget or a stop condition hit. */
  hasMore: boolean
  /** The merged topic summaries. */
  topics: TopicSummary[]
}

/** The `tgb_get_replies` canonical output value. */
export interface RepliesValue {
  /** The queried user id. */
  userID: number
  /** The 1-based page the collection started at. */
  pageNo: number
  /** Pages actually fetched. */
  pagesFetched: number
  /** Whether fresh data remained when the budget or a stop condition hit. */
  hasMore: boolean
  /** The merged reply items. */
  replies: ReplyItem[]
}

/** The `tgb_get_follows` canonical output value. */
export interface FollowsValue {
  /** The owner user id the follow list belongs to. */
  userID: number
  /** How many users the owner follows in total. */
  followNum: number
  /** How many fans the owner has. */
  fansNum: number
  /** Pages actually fetched. */
  pagesFetched: number
  /** Whether fresh data remained when the budget or a stop condition hit. */
  hasMore: boolean
  /** The merged followed users. */
  follows: FollowUser[]
}

/** The `tgb_get_home_sections` canonical output value. */
export interface HomeSectionsValue extends HomeSections {
  /** Realtime quotes for the hot stocks, present only when requested. */
  quotes?: StockQuote[]
}

/** The footer appended when a rendered output was cut. */
const TRUNCATION_FOOTER = '\n\n(Output truncated. Narrow the request — fewer pages or a specific page — for the rest.)'

/**
 * Bound one rendered output to the configured cap.
 *
 * @param text - the complete rendered text.
 * @param maxOutputChars - the cap on the complete returned string.
 * @returns the content blocks carrying the bounded text.
 */
function boundedText(text: string, maxOutputChars: number): ContentBlock[] {
  if (text.length <= maxOutputChars) return [{ type: 'text', text }]
  if (maxOutputChars <= TRUNCATION_FOOTER.length) return [{ type: 'text', text: text.slice(0, maxOutputChars) }]
  return [{ type: 'text', text: `${text.slice(0, maxOutputChars - TRUNCATION_FOOTER.length)}${TRUNCATION_FOOTER}` }]
}

/**
 * Validate and resolve the pagination arguments the DSL cannot express: both
 * counts must be positive integers, and `maxPages` may not exceed the
 * deployment's configured budget.
 *
 * @param args - the raw tool arguments.
 * @param maxPagesLimit - the configured page budget.
 * @returns the resolved start page and page budget.
 */
function resolvePageArgs(args: { pageNo?: number; maxPages?: number }, maxPagesLimit: number): { pageNo: number; maxPages: number } {
  // The schemas already enforce integers; only the ordering facts remain here.
  const pageNo = args.pageNo ?? 1
  if (pageNo < 1) throw new Error('pageNo must be a positive integer')
  const maxPages = args.maxPages ?? maxPagesLimit
  if (maxPages < 1) throw new Error('maxPages must be a positive integer')
  if (maxPages > maxPagesLimit) throw new Error(`maxPages must be at most ${maxPagesLimit}`)
  return { pageNo, maxPages }
}

/** The shared topic-summary output item schema. */
const TOPIC_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topicID: { type: 'string', required: true },
    code: { type: 'string', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
    author: { type: 'string', required: true },
    authorID: { type: 'string', required: true },
    lastReplyTime: { type: 'string', required: true },
    replies: { type: 'integer', required: true },
    views: { type: 'integer', required: true },
    tickets: { type: 'integer', required: true },
    likes: { type: 'integer', required: true },
    publishDate: { type: 'string', required: true },
  },
} as const

/** The shared reply-item output item schema. */
const REPLY_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userName: { type: 'string', required: true },
    replyTime: { type: 'string', required: true },
    sourceCode: { type: 'string', required: true },
    sourceUrl: { type: 'string', required: true },
    sourceTitle: { type: 'string', required: true },
    replyId: { type: 'string', required: true },
    replyUrl: { type: 'string', required: true },
    content: { type: 'string', required: true },
    comments: { type: 'integer', required: true },
    likes: { type: 'integer', required: true },
    postAuthor: { type: 'string', required: true },
    postDate: { type: 'string', required: true },
  },
} as const

/** The shared followed-user output item schema. */
const FOLLOW_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userID: { type: 'integer', required: true },
    userName: { type: 'string', required: true },
    portrait: { type: 'string', required: true },
    gender: { type: 'string', required: true },
    fansNum: { type: 'integer', required: true },
    followNum: { type: 'integer', required: true },
    usefulNum: { type: 'integer', required: true },
    bestBBSNums: { type: 'integer', required: true },
    createDate: { type: 'string', required: true },
  },
} as const

/** The `userID` parameter description shared by the user-scoped tools. */
const USER_ID_DESCRIPTION = 'The numeric tgb.cn user id (the digits in a /blog/{id} URL).'

/** The `pageNo` parameter schema shared by the paginated tools. */
const PAGE_NO_PARAM = { type: 'integer', description: 'The 1-based page to start from. Defaults to 1.' } as const

/** The `maxPages` parameter schema shared by the paginated tools. */
const MAX_PAGES_PARAM = { type: 'integer', description: 'How many pages to fetch in this call, starting at pageNo. Defaults to the configured budget.' } as const

/**
 * Format one paginated result's progress line.
 *
 * @param prefix - the result's subject (user id or section name).
 * @param pagesFetched - pages actually fetched.
 * @param hasMore - whether fresh data remained.
 * @returns the progress line.
 */
function progressLine(prefix: string, pagesFetched: number, hasMore: boolean): string {
  return `${prefix} — ${pagesFetched} page${pagesFetched === 1 ? '' : 's'} fetched${hasMore ? '; more pages are available' : ''}.`
}

/**
 * Register the five tgb tools on the context's tool registry.
 *
 * @param ctx - context whose `tools` registry receives the registrations.
 * @param client - the shared site client.
 * @param limits - the deployment's pagination, timeout, and output bounds.
 */
export function applyTgbTools(ctx: Context, client: TgbClient, limits: ToolLimits): void {
  ctx.tools.register(defineTool({
    name: 'tgb_get_topics',
    description: 'List one tgb.cn user\'s topics (主贴) with per-topic counters; paginate with pageNo/maxPages.',
    parameters: {
      userID: { type: 'integer', required: true, description: USER_ID_DESCRIPTION },
      pageNo: PAGE_NO_PARAM,
      maxPages: MAX_PAGES_PARAM,
      sortFlag: { type: 'string', enum: ['R'], description: 'Pass "R" to order by latest reply instead of the site default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userID: { type: 'integer', required: true },
          pageNo: { type: 'integer', required: true },
          pagesFetched: { type: 'integer', required: true },
          hasMore: { type: 'boolean', required: true },
          topics: { type: 'array', required: true, items: TOPIC_ITEM_SCHEMA },
        },
      },
      render: (_args, value) => boundedText(formatTopics(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { pageNo, maxPages } = resolvePageArgs(args, limits.maxPages)
      const batch = await client.collectPages({
        build: page => moreTopicUrl(args.userID, pageNo + page - 1, args.sortFlag),
        fetchPage: async (url, signal) => parseTopicsPage(await client.fetchPage(url, signal)),
        idOf: topic => topic.topicID,
        maxPages,
        signal: exec.signal,
      })
      return {
        userID: args.userID,
        pageNo,
        pagesFetched: batch.pagesFetched,
        hasMore: batch.hasMore,
        topics: batch.items,
      }
    },
    presentCall: args => ({ card: 'generic', title: `tgb.cn topics of user ${args.userID}`, kind: 'fetch' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tgb_get_topic_content',
    description: 'Fetch one tgb.cn topic\'s first post (主贴内容): metadata plus the body as markdown. Take the code from tgb_get_topics results.',
    parameters: {
      code: { type: 'string', required: true, description: 'The topic\'s /a/ short code (letters and digits only, for example "1ykHx9mgs4W"). Not a URL.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          author: { type: 'string', required: true },
          authorID: { type: 'string', required: true },
          publishDate: { type: 'string', required: true },
          views: { type: 'integer', required: true },
          replies: { type: 'integer', required: true },
          tickets: { type: 'integer', required: true },
          contentMarkdown: { type: 'string', required: true },
        },
      },
      render: (_args, value) => boundedText(formatTopicContent(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const code = args.code.trim()
      if (!/^[A-Za-z0-9]+$/u.test(code)) throw new Error('code must be the topic\'s /a/ short code (letters and digits only), not a URL')
      const html = await client.fetchPage(topicUrl(code), exec.signal)
      return parseTopicContentPage(html, code)
    },
    presentCall: args => ({ card: 'generic', title: `tgb.cn topic ${args.code}`, kind: 'fetch' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tgb_get_replies',
    description: 'List one tgb.cn user\'s replies (跟帖): where they replied, the reply text, and the source topic; paginate with pageNo/maxPages.',
    parameters: {
      userID: { type: 'integer', required: true, description: USER_ID_DESCRIPTION },
      pageNo: PAGE_NO_PARAM,
      maxPages: MAX_PAGES_PARAM,
      time: { type: 'string', description: 'Optional date filter, YYYY-MM-DD. Omit for all dates.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userID: { type: 'integer', required: true },
          pageNo: { type: 'integer', required: true },
          pagesFetched: { type: 'integer', required: true },
          hasMore: { type: 'boolean', required: true },
          replies: { type: 'array', required: true, items: REPLY_ITEM_SCHEMA },
        },
      },
      render: (_args, value) => boundedText(formatReplies(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { pageNo, maxPages } = resolvePageArgs(args, limits.maxPages)
      const time = args.time === undefined || args.time === '' ? undefined : args.time
      if (time !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(time)) throw new Error('time must be a YYYY-MM-DD date')
      const batch = await client.collectPages({
        build: page => moreRepliesUrl(args.userID, pageNo + page - 1, time),
        fetchPage: async (url, signal) => parseRepliesPage(await client.fetchPage(url, signal)),
        idOf: reply => `${reply.sourceCode}/${reply.replyId}`,
        maxPages,
        signal: exec.signal,
      })
      return {
        userID: args.userID,
        pageNo,
        pagesFetched: batch.pagesFetched,
        hasMore: batch.hasMore,
        replies: batch.items,
      }
    },
    presentCall: args => ({ card: 'generic', title: `tgb.cn replies of user ${args.userID}`, kind: 'fetch' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tgb_get_follows',
    description: 'List one tgb.cn user\'s followed users (关注列表). Without userID, uses the logged-in user from the configured cookie; paginate with pageNo/maxPages.',
    parameters: {
      userID: { type: 'integer', description: `The list owner's user id. ${USER_ID_DESCRIPTION} Defaults to the logged-in user.` },
      pageNo: PAGE_NO_PARAM,
      maxPages: MAX_PAGES_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          userID: { type: 'integer', required: true },
          followNum: { type: 'integer', required: true },
          fansNum: { type: 'integer', required: true },
          pagesFetched: { type: 'integer', required: true },
          hasMore: { type: 'boolean', required: true },
          follows: { type: 'array', required: true, items: FOLLOW_ITEM_SCHEMA },
        },
      },
      render: (_args, value) => boundedText(formatFollows(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { pageNo, maxPages } = resolvePageArgs(args, limits.maxPages)
      const userID = args.userID ?? (await loginUserID(client, exec.signal))
      let followNum = 0
      let fansNum = 0
      const batch = await client.collectPages({
        build: page => followsUrl(userID, pageNo + page - 1),
        fetchPage: async (url, signal) => {
          const page = parseFollowsPage(await client.fetchJson(url, signal))
          if (followNum === 0 && fansNum === 0) {
            followNum = page.followNum
            fansNum = page.fansNum
          }
          return page.list
        },
        idOf: follow => String(follow.userID),
        maxPages,
        signal: exec.signal,
      })
      return {
        userID,
        followNum,
        fansNum,
        pagesFetched: batch.pagesFetched,
        hasMore: batch.hasMore,
        follows: batch.items,
      }
    },
    presentCall: args => ({ card: 'generic', title: `tgb.cn follows of user ${args.userID ?? '<current>'}`, kind: 'fetch' }),
  }))

  ctx.tools.register(defineTool({
    name: 'tgb_get_home_sections',
    description: 'Read the tgb.cn home page\'s 本周上升达人 (weekly rising stars) and 热门研股 (hot research stocks) sections, optionally with realtime quotes.',
    parameters: {
      includeQuotes: { type: 'boolean', description: 'Set true to also fetch realtime quotes for the hot stocks. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          weekUpStars: { type: 'array', required: true, items: WEEK_UP_ITEM_SCHEMA },
          hotStocks: { type: 'array', required: true, items: HOT_STOCK_ITEM_SCHEMA },
          quotes: { type: 'array', items: QUOTE_ITEM_SCHEMA },
        },
      },
      render: (_args, value) => boundedText(formatHomeSections(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const sections = parseHomePage(await client.fetchPage(homeUrl(), exec.signal))
      if (args.includeQuotes !== true || sections.hotStocks.length === 0) return sections
      const codes = sections.hotStocks.map(stock => stock.code)
      const quotes = parseQuotesPage(await client.fetchJson(realHQUrl(codes), exec.signal), codes)
      return { ...sections, quotes }
    },
    presentCall: () => ({ card: 'generic', title: 'tgb.cn home sections', kind: 'fetch' }),
  }))
}

/** The weekly-rising-star output item schema. */
const WEEK_UP_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userID: { type: 'string', required: true },
    userName: { type: 'string', required: true },
    portrait: { type: 'string', required: true },
    fansNum: { type: 'integer', required: true },
    articleCount: { type: 'integer', required: true },
    viewers: { type: 'integer', required: true },
  },
} as const

/** The hot-stock output item schema. */
const HOT_STOCK_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    name: { type: 'string', required: true },
    rate: { type: 'string', required: true },
    diggers: { type: 'string', required: true },
  },
} as const

/** The realtime-quote output item schema. */
const QUOTE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    name: { type: 'string', required: true },
    price: { type: 'number', required: true },
    changeRate: { type: 'number', required: true },
    lastTime: { type: 'string', required: true },
  },
} as const

/**
 * Resolve the logged-in user's id through the configured cookie.
 *
 * @param client - the site client.
 * @param signal - cancellation signal.
 * @returns the logged-in user's id.
 */
async function loginUserID(client: TgbClient, signal: AbortSignal): Promise<number> {
  const state = parseLoginState(await client.fetchJson(isLoginUrl(), signal))
  return state.userID
}

/**
 * Format the topic list result as one markdown block.
 *
 * @param value - the canonical output value.
 * @returns the rendered text.
 */
function formatTopics(value: TopicsValue): string {
  const lines = value.topics.map(topic =>
    `- [${topic.title}](${topic.url}) — ${topic.author} · 回 ${topic.replies}/浏览 ${topic.views} · 赞 ${topic.likes} · 发布 ${topic.publishDate}`)
  return [progressLine(`Topics of user ${value.userID}`, value.pagesFetched, value.hasMore), ...lines].join('\n')
}

/**
 * Format the topic content result as one markdown block.
 *
 * @param value - the canonical output value.
 * @returns the rendered text.
 */
function formatTopicContent(value: TopicContent): string {
  return [
    `# ${value.title}`,
    '',
    `${value.author} · ${value.publishDate} · 浏览 ${value.views} · 评论 ${value.replies} · 加油 ${value.tickets}`,
    '',
    value.contentMarkdown,
  ].join('\n')
}

/**
 * Format the reply list result as one markdown block.
 *
 * @param value - the canonical output value.
 * @returns the rendered text.
 */
function formatReplies(value: RepliesValue): string {
  const lines = value.replies.map(reply =>
    `- ${reply.replyTime} ${reply.content} — 来自 [《${reply.sourceTitle}》](${reply.replyUrl}) · 赞 ${reply.likes}`)
  return [progressLine(`Replies of user ${value.userID}`, value.pagesFetched, value.hasMore), ...lines].join('\n')
}

/**
 * Format the follow list result as one markdown block.
 *
 * @param value - the canonical output value.
 * @returns the rendered text.
 */
function formatFollows(value: FollowsValue): string {
  const lines = value.follows.map(follow =>
    `- ${follow.userName} (ID ${follow.userID}) · 粉丝 ${follow.fansNum} · 加油 ${follow.usefulNum} · 精华 ${follow.bestBBSNums} · 关注于 ${follow.createDate}`)
  return [progressLine(`Follows of user ${value.userID} (共 ${value.followNum}, 粉丝 ${value.fansNum})`, value.pagesFetched, value.hasMore), ...lines].join('\n')
}

/**
 * Format the home sections result as one markdown block.
 *
 * @param value - the canonical output value.
 * @returns the rendered text.
 */
function formatHomeSections(value: HomeSectionsValue): string {
  const stars = value.weekUpStars.map(star =>
    `- [${star.userName}](https://www.tgb.cn/blog/${star.userID}) · 粉丝 ${star.fansNum} · ${star.articleCount}篇 · 7日围观 ${star.viewers}`)
  const stocks = value.hotStocks.map(stock =>
    `- ${stock.name} (${stock.code}) · ${stock.rate} · ${stock.diggers}`)
  const sections = [
    '## 本周上升达人',
    ...stars,
    '',
    '## 热门研股',
    ...stocks,
  ]
  if (value.quotes !== undefined) {
    sections.push('', '## 实时行情', ...value.quotes.map(quote =>
      `- ${quote.name} (${quote.code}) · ${quote.price} · ${quote.changeRate}% · ${quote.lastTime}`))
  }
  return sections.join('\n')
}
