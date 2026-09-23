/**
 * The tgb.cn blogger source over the recorded page fixtures and a stubbed
 * transport: reference resolution, post/reply mapping, and the pagination facts
 * the seam reports back to its consumer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TgbClient } from '@deepseek-ai/dsh-tool-tgb'
import { TgbBloggerSource } from '@deepseek-ai/dsh-blogger-source-tgb'
import { StubCredentials, stubFetch } from './helpers.ts'

const testSignal = new AbortController().signal

/** Mount one source over a real context, a real client, and the stubbed transport. */
async function mountSource(): Promise<TgbBloggerSource> {
  const ctx = new Context()
  await ctx.plugin(StubCredentials, { value: 'tgbuser=1' })
  const client = new TgbClient(ctx, {
    cookieRef: credentialRef('TGB_COOKIE'),
    timeoutMs: 30_000,
    maxResponseBytes: 4_000_000,
    userAgent: 'blogger-source-tgb-test',
    requestIntervalMs: 0,
  })
  return new TgbBloggerSource(client)
}

beforeEach(() => {
  vi.stubGlobal('fetch', stubFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TgbBloggerSource references', () => {
  it('matches ids and profile URLs, and rejects anything else', async () => {
    const source = await mountSource()
    expect(source.id).toBe('tgb')
    expect(source.displayName).toBe('淘股吧 (tgb.cn)')
    expect(source.matches('905478')).toBe(true)
    expect(source.matches('https://www.tgb.cn/blog/905478')).toBe(true)
    expect(source.matches('enbool')).toBe(false)
  })

  it('resolves a canonical identity without a network request', async () => {
    const source = await mountSource()
    await expect(source.resolve(' https://shuo.tgb.cn/blog/905478 ', testSignal)).resolves.toEqual({
      source: 'tgb',
      userID: '905478',
      profileUrl: 'https://www.tgb.cn/blog/905478',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails BLOGGER_REFERENCE_INVALID on a reference its own grammar rejects', async () => {
    const source = await mountSource()
    await expect(source.resolve('enbool', testSignal))
      .rejects.toThrow(expect.objectContaining({ code: 'BLOGGER_REFERENCE_INVALID' }))
  })
})

describe('TgbBloggerSource collection', () => {
  const ref = { source: 'tgb', userID: '905478', profileUrl: 'https://www.tgb.cn/blog/905478' }

  it('maps one topic page onto post summaries', async () => {
    const source = await mountSource()
    const page = await source.listPosts(ref, { pageNo: 1, maxPages: 1, signal: testSignal })

    expect(page).toMatchObject({ pageNo: 1, pagesFetched: 1, hasMore: true })
    expect(page.items).toHaveLength(4)
    expect(page.items[0]).toEqual({
      id: '1ykHx9mgs4W',
      url: 'https://www.tgb.cn/a/1ykHx9mgs4W',
      title: '大盘走势很标准的背驰，这波反弹应该结束了',
      publishedAt: '2020-04-19',
      replies: 0,
      views: 546,
      likes: 2,
    })
  })

  it('stops on the site re-serving page one past the end', async () => {
    const source = await mountSource()
    const page = await source.listPosts(ref, { pageNo: 1, maxPages: 5, signal: testSignal })

    expect(page).toMatchObject({ pagesFetched: 2, hasMore: false })
    expect(page.items).toHaveLength(4)
  })

  it('maps one topic page onto a post body', async () => {
    const source = await mountSource()
    const post = await source.fetchPost(ref, '1ykHx9mgs4W', testSignal)

    expect(post).toMatchObject({
      id: '1ykHx9mgs4W',
      url: 'https://www.tgb.cn/a/1ykHx9mgs4W',
      title: '大盘走势很标准的背驰，这波反弹应该结束了',
      publishedAt: '2020-04-19 21:16',
      views: 544,
      replies: 0,
    })
    expect(post.bodyMarkdown).toContain('管住手')
  })

  it('maps one reply page onto seam replies', async () => {
    const source = await mountSource()
    const page = await source.listReplies(ref, { pageNo: 1, maxPages: 1, signal: testSignal })

    expect(page).toMatchObject({ pageNo: 1, pagesFetched: 1, hasMore: true })
    expect(page.items.length).toBeGreaterThan(5)
    expect(page.items[0]).toEqual({
      id: '2k5fgcbtVDC/97158806',
      url: 'https://www.tgb.cn/a/2k5fgcbtVDC/97158806#97158806',
      topicTitle: '500万实盘，不到1亿不封贴',
      topicUrl: 'https://www.tgb.cn/a/2k5fgcbtVDC',
      repliedAt: '2026-03-30 16:05',
      body: '机会就在明天',
      likes: 0,
    })
  })

  it('addresses the requested start page and user id', async () => {
    const source = await mountSource()
    await source.listPosts(ref, { pageNo: 3, maxPages: 1, signal: testSignal })

    const requested = vi.mocked(fetch).mock.calls[0]?.[0] as URL
    expect(requested.searchParams.get('pageNo')).toBe('3')
    expect(requested.searchParams.get('userID')).toBe('905478')
  })
})
