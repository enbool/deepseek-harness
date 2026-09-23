/**
 * Real composition test: the blogger-source-tgb plugin boots through the real
 * Loader unwrap path onto a real blogger registry and a real credential
 * provider, and resolves plus collects one blogger end-to-end with only the
 * network transport stubbed. Also guards the namespace export shape (see the
 * tool-web postmortem: a default export would collapse the namespace and drop
 * `inject`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import BloggerSourceRegistry from '@deepseek-ai/dsh-blogger'
import * as bloggerSourceTgb from '@deepseek-ai/dsh-blogger-source-tgb'
import { StubCredentials, stubFetch } from './helpers.ts'

const testSignal = new AbortController().signal

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dsh-blogger-source-tgb real composition', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in bloggerSourceTgb).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(bloggerSourceTgb) as Record<string, unknown>
    expect(unwrapped).toBe(bloggerSourceTgb)
    expect(unwrapped.name).toBe('blogger-source-tgb')
    expect(unwrapped.inject).toEqual(['bloggers', 'credentials'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('registers the tgb source through the unwrapped module and disposes it with the fiber', async () => {
    vi.stubGlobal('fetch', stubFetch())

    const ctx = new Context()
    await ctx.plugin(BloggerSourceRegistry)
    await ctx.plugin(StubCredentials, { value: 'tgbuser=1' })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(bloggerSourceTgb) as Parameters<Context['plugin']>[0]
    // Mounting the collapsed shape would throw for missing injection here.
    const fiber = await ctx.plugin(unwrapped, { cookie: 'TGB_COOKIE' })
    expect(ctx.bloggers.list()).toEqual([{ id: 'tgb', displayName: '淘股吧 (tgb.cn)' }])

    const { ref } = await ctx.bloggers.resolve('https://www.tgb.cn/blog/905478', testSignal)
    expect(ref.userID).toBe('905478')
    const posts = await ctx.bloggers.require('tgb').listPosts(ref, { pageNo: 1, maxPages: 1, signal: testSignal })
    expect(posts.items).toHaveLength(4)

    // Disposal through the real fiber unregisters the source.
    await fiber.dispose()
    expect(ctx.bloggers.list()).toEqual([])
  })

  it('requires the cookie credential reference at load', async () => {
    const ctx = new Context()
    await ctx.plugin(BloggerSourceRegistry)
    await ctx.plugin(StubCredentials, { value: 'tgbuser=1' })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(bloggerSourceTgb) as Parameters<Context['plugin']>[0]
    await expect(ctx.plugin(unwrapped, { cookie: 'not a credential ref' })).rejects.toThrow()
  })
})
