/**
 * Tool-suite tests through the real tool registry: schemas, argument
 * validation, rendering, disposal, and config-driven bounds, with the site
 * transport stubbed and the parsers exercised over the recorded fixtures.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolTgb from '@deepseek-ai/dsh-tool-tgb'

const testToolSignal = new AbortController().signal

const moreTopicHtml = readFileSync(fileURLToPath(new URL('./fixtures/more-topic.html', import.meta.url)), 'utf8')
const topicContentHtml = readFileSync(fileURLToPath(new URL('./fixtures/topic-content.html', import.meta.url)), 'utf8')
const moreRepliesHtml = readFileSync(fileURLToPath(new URL('./fixtures/more-replies.html', import.meta.url)), 'utf8')
const homeHtml = readFileSync(fileURLToPath(new URL('./fixtures/home.html', import.meta.url)), 'utf8')
const followsJson = readFileSync(fileURLToPath(new URL('./fixtures/follows.json', import.meta.url)), 'utf8')
const quotesJson = JSON.stringify({
  status: true,
  dto: [{ fullCode: 'sh600448', name: '华纺股份', price: 3.89, pxChangeRate: 9.89, lastTime: '14:21:21' }],
})

/** A credential provider answering one fixed value (or nothing). */
class StubCredentials extends CredentialProvider {
  private readonly value: string | undefined

  constructor(_ctx: Context, config: { value?: string }) {
    super(_ctx)
    this.value = config.value
  }

  override resolve(): Promise<{ value: string; source: string } | undefined> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'test' })
  }

  override describe(): never {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override set(): Promise<void> {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }

  override unset(): Promise<void> {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }

  override readRecord(): never {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override describeRecord(): never {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override listRecords(): never {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override modifyRecord(): Promise<undefined> {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }

  override deleteRecord(): Promise<void> {
    /* v8 ignore next -- the tool suite only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }
}

/** Route a stubbed fetch by URL to the recorded fixtures. */
function stubFetchByURL(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: URL | string) => {
    const href = input instanceof URL ? input.href : input
    const respond = (body: string, type = 'text/html') => new Response(body, { status: 200, headers: { 'content-type': type } })
    if (href.includes('/user/blog/moreTopic')) return respond(moreTopicHtml)
    if (href.includes('/user/blog/moreReplyMod')) return respond(moreRepliesHtml)
    if (href.includes('/a/')) return respond(topicContentHtml)
    if (href.includes('getUserBlogShuoFollow')) return respond(followsJson, 'application/json')
    if (href.includes('realHQList')) return respond(quotesJson, 'application/json')
    if (href.includes('/user/getIsLogin')) return respond(JSON.stringify({ status: true, dto: { userID: 905478, userName: 'enbool' } }), 'application/json')
    if (href === 'https://www.tgb.cn/' || href.startsWith('https://www.tgb.cn/?')) return respond(homeHtml)
    throw new Error(`stub fetch has no answer for ${href}`)
  })
}

/** Mount the real registry with the tool-tgb plugin over the stubbed transport. A `null` cookie value mounts an unconfigured credential. */
async function mountTools(config: ToolTgb.Config = { cookie: 'TGB_COOKIE' }, cookieValue: string | null = 'tgbuser=1') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubCredentials, cookieValue === null ? {} : { value: cookieValue })
  vi.stubGlobal('fetch', stubFetchByURL())
  const fiber = await ctx.plugin(ToolTgb, config)
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`call-${++counter}`), name, arguments: args })
  return { ctx, fiber, call }
}

beforeEach(() => {
  vi.stubGlobal('fetch', stubFetchByURL())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tool-tgb registration', () => {
  it('registers the five tools and disposes them with the fiber', async () => {
    const { ctx, fiber } = await mountTools()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining([
      'tgb_get_topics', 'tgb_get_topic_content', 'tgb_get_replies', 'tgb_get_follows', 'tgb_get_home_sections',
    ]))
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('tgb_get_topics')
  })

  it.each([
    ['timeoutMs', { cookie: 'TGB_COOKIE', timeoutMs: 0 }],
    ['maxPages', { cookie: 'TGB_COOKIE', maxPages: 0 }],
    ['maxResponseBytes', { cookie: 'TGB_COOKIE', maxResponseBytes: 0 }],
    ['maxOutputChars', { cookie: 'TGB_COOKIE', maxOutputChars: 0 }],
    ['requestIntervalMs', { cookie: 'TGB_COOKIE', requestIntervalMs: -1 }],
  ])('rejects an out-of-bounds %s at load', async (name, config) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubCredentials, { value: 'tgbuser=1' })
    await expect(ctx.plugin(ToolTgb, config)).rejects.toThrow(new RegExp(`invalid config[\\s\\S]*${name}`))
  })

  it('rejects a cookie reference outside the reference grammar at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubCredentials, { value: 'tgbuser=1' })
    await expect(ctx.plugin(ToolTgb, { cookie: 'not a ref' })).rejects.toThrow(/credential ref/)
  })
})

describe('tgb_get_topics through the registry', () => {
  it('returns the topics and renders a markdown list', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_topics', { userID: 905478 })
    expect(out.isError).toBe(false)
    const value = out.value as { userID: number; pagesFetched: number; hasMore: boolean; topics: { topicID: string }[] }
    expect(value.userID).toBe(905478)
    // The stub serves the same fixture for every page, so the duplicate-first-item
    // guard stops after the second fetch instead of a second page of new data.
    expect(value.pagesFetched).toBe(2)
    expect(value.hasMore).toBe(false)
    expect(value.topics).toHaveLength(4)
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('[大盘走势很标准的背驰，这波反弹应该结束了](https://www.tgb.cn/a/1ykHx9mgs4W)')
    expect(text).toContain('2 pages fetched')
    await fiber.dispose()
  })

  it('rejects a maxPages above the configured budget before any request', async () => {
    const { fiber, call } = await mountTools({ cookie: 'TGB_COOKIE', maxPages: 2 })
    const out = await call('tgb_get_topics', { userID: 905478, maxPages: 3 })
    expect(out.isError).toBe(true)
    expect(out.content).toEqual([{ type: 'text', text: 'Error: maxPages must be at most 2' }])
    await fiber.dispose()
  })

  it.each([
    [{ userID: 905478, pageNo: 0 }],
    [{ userID: 905478, maxPages: 0 }],
  ])('rejects %j as a pagination argument error', async (args) => {
    const { fiber, call } = await mountTools({ cookie: 'TGB_COOKIE', maxPages: 2 })
    const out = await call('tgb_get_topics', args)
    expect(out.isError).toBe(true)
    expect(out.content.map(block => block.type === 'text' ? block.text : '').join('')).toMatch(/must be a positive integer|must be at most 2/)
    await fiber.dispose()
  })

  it.each([{}, { userID: 'x' }])('rejects %j as INVALID_ARGS', async (args) => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_topics', args)
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('INVALID_ARGS')
    await fiber.dispose()
  })

  it('surfaces an unconfigured cookie as a structured TGB_AUTH_REQUIRED error', async () => {
    const { fiber, call } = await mountTools({ cookie: 'TGB_COOKIE' }, null)
    const out = await call('tgb_get_topics', { userID: 905478 })
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('TGB_AUTH_REQUIRED')
    await fiber.dispose()
  })
})

describe('tgb_get_topic_content through the registry', () => {
  it('returns the topic content and renders the markdown body', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_topic_content', { code: '1ykHx9mgs4W' })
    expect(out.isError).toBe(false)
    expect((out.value as { title: string }).title).toBe('大盘走势很标准的背驰，这波反弹应该结束了')
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('# 大盘走势很标准的背驰，这波反弹应该结束了')
    expect(text).toContain('管住手')
    await fiber.dispose()
  })

  it('rejects a URL in place of the short code', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_topic_content', { code: 'https://www.tgb.cn/a/1ykHx9mgs4W' })
    expect(out.isError).toBe(true)
    expect(out.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('short code')
    await fiber.dispose()
  })
})

describe('tgb_get_replies and tgb_get_follows through the registry', () => {
  it('returns the replies and renders them', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_replies', { userID: 905478 })
    expect(out.isError).toBe(false)
    const value = out.value as { replies: { replyId: string }[] }
    expect(value.replies.length).toBeGreaterThan(5)
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('机会就在明天')
    await fiber.dispose()
  })

  it('rejects a malformed time filter', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_replies', { userID: 905478, time: '2026/03/30' })
    expect(out.isError).toBe(true)
    expect(out.content.map(block => block.type === 'text' ? block.text : '').join('')).toContain('YYYY-MM-DD')
    await fiber.dispose()
  })

  it('uses the given userID directly for follows', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_follows', { userID: 905478 })
    expect(out.isError).toBe(false)
    const value = out.value as { userID: number; followNum: number; follows: { userName: string }[] }
    expect(value.userID).toBe(905478)
    expect(value.followNum).toBe(29)
    expect(value.follows[0]?.userName).toBe('A拉神灯')
    await fiber.dispose()
  })

  it('resolves the logged-in user when userID is omitted', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_follows', {})
    expect(out.isError).toBe(false)
    expect((out.value as { userID: number }).userID).toBe(905478)
    await fiber.dispose()
  })

  it('bounds the rendered output with the truncation footer', async () => {
    const { fiber, call } = await mountTools({ cookie: 'TGB_COOKIE', maxOutputChars: 200 })
    const out = await call('tgb_get_follows', { userID: 905478 })
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).toContain('Output truncated')
    await fiber.dispose()
  })

  it('bounds the rendered output when the cap is tinier than the truncation footer', async () => {
    const { fiber, call } = await mountTools({ cookie: 'TGB_COOKIE', maxOutputChars: 20 })
    const out = await call('tgb_get_follows', { userID: 905478 })
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toHaveLength(20)
    expect(text).not.toContain('Output truncated')
    await fiber.dispose()
  })

  it('reports a one-page result in the singular', async () => {
    const { fiber, call } = await mountTools()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ status: true, dto: { followNum: 1, fansNum: 0, list: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    const out = await call('tgb_get_follows', { userID: 905478 })
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('1 page fetched')
    await fiber.dispose()
  })

  it('reports a budget-stopped result as having more pages', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_follows', { userID: 905478, maxPages: 1 })
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('1 page fetched; more pages are available')
    await fiber.dispose()
  })
})

describe('tgb_get_home_sections through the registry', () => {
  it('returns both sections without quotes by default', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_home_sections', {})
    expect(out.isError).toBe(false)
    const value = out.value as { weekUpStars: unknown[]; hotStocks: unknown[]; quotes?: unknown }
    expect(value.weekUpStars.length).toBeGreaterThanOrEqual(10)
    expect(value.hotStocks).toHaveLength(5)
    expect(value.quotes).toBeUndefined()
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('本周上升达人')
    expect(text).toContain('华纺股份')
    await fiber.dispose()
  })

  it('appends realtime quotes when requested', async () => {
    const { fiber, call } = await mountTools()
    const out = await call('tgb_get_home_sections', { includeQuotes: true })
    expect(out.isError).toBe(false)
    const value = out.value as { quotes?: { code: string; price: number }[] }
    expect(value.quotes).toEqual([{ code: 'sh600448', name: '华纺股份', price: 3.89, changeRate: 9.89, lastTime: '14:21:21' }])
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('实时行情')
    await fiber.dispose()
  })
})

describe('transport failures surface as structured error results', () => {
  it('maps an SSO redirect to TGB_AUTH_REQUIRED', async () => {
    const { fiber, call } = await mountTools()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://sso.tgb.cn/web/login/index' } })))
    const out = await call('tgb_get_topics', { userID: 905478 })
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('TGB_AUTH_REQUIRED')
    await fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ToolTgb).toBe(false)
  })
})

describe('pending-call presentation', () => {
  it.each([
    ['tgb_get_topics', { userID: 905478 }],
    ['tgb_get_topic_content', { code: '1ykHx9mgs4W' }],
    ['tgb_get_replies', { userID: 905478 }],
    ['tgb_get_follows', { userID: 905478 }],
    ['tgb_get_home_sections', {}],
  ])('classifies %s as parallel-safe', async (name, args) => {
    const { ctx, fiber } = await mountTools()
    const mode = ctx.tools.executionMode({ signal: testToolSignal, callId: ToolCallId(`mode-${name}`), name, arguments: args })
    expect(mode).toEqual({ kind: 'parallel' })
    await fiber.dispose()
  })

  it.each([
    ['tgb_get_topics', { userID: 905478 }, { title: 'tgb.cn topics of user 905478' }],
    ['tgb_get_topic_content', { code: '1ykHx9mgs4W' }, { title: 'tgb.cn topic 1ykHx9mgs4W' }],
    ['tgb_get_replies', { userID: 905478 }, { title: 'tgb.cn replies of user 905478' }],
    ['tgb_get_follows', { userID: 905478 }, { title: 'tgb.cn follows of user 905478' }],
    ['tgb_get_follows', {}, { title: 'tgb.cn follows of user <current>' }],
    ['tgb_get_home_sections', {}, { title: 'tgb.cn home sections' }],
  ])('presents %s (%j) as a generic fetch card', async (name, args, expected) => {
    const { ctx, fiber } = await mountTools()
    const view = ctx.tools.get(name)?.presentCall?.(args)
    expect(view).toEqual({ card: 'generic', kind: 'fetch', ...expected })
    await fiber.dispose()
  })
})
