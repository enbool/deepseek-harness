/**
 * Registry and resolution contract for the blogger source seam: registration
 * lifetime, duplicate and unknown-id failures, and the reference resolution
 * rules that never depend on registration order.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BloggerSourceRegistry, {
  type BloggerRef,
  type BloggerSource,
} from '@deepseek-ai/dsh-blogger'

const testSignal = new AbortController().signal

/** A source accepting one caller-chosen reference shape and reporting what it resolved. */
function makeSource(id: string, accepts: (input: string) => boolean): BloggerSource {
  return {
    id,
    displayName: `${id} platform`,
    matches: accepts,
    resolve: input => Promise.resolve({ source: id, userID: `resolved:${input}` } satisfies BloggerRef),
    listPosts: () => Promise.resolve({ items: [], pageNo: 1, pagesFetched: 0, hasMore: false }),
    fetchPost: (_ref, postId) => Promise.resolve({
      id: postId, url: '', title: '', publishedAt: '', bodyMarkdown: '',
    }),
    listReplies: () => Promise.resolve({ items: [], pageNo: 1, pagesFetched: 0, hasMore: false }),
  }
}

/** Mount a fresh registry on a new context. */
async function mount(): Promise<{ ctx: Context; bloggers: BloggerSourceRegistry }> {
  const ctx = new Context()
  await ctx.plugin(BloggerSourceRegistry)
  return { ctx, bloggers: ctx.bloggers }
}

describe('blogger source registry', () => {
  it('lists sources in registration order and disposes them with the contributing fiber (HMR safety)', async () => {
    const { ctx } = await mount()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.bloggers.register(makeSource('alpha', () => false))
      inner.bloggers.register(makeSource('beta', () => false))
    }, { inject: ['bloggers'] }))

    expect(ctx.bloggers.list()).toEqual([
      { id: 'alpha', displayName: 'alpha platform' },
      { id: 'beta', displayName: 'beta platform' },
    ])

    await fiber.dispose()
    expect(ctx.bloggers.list()).toEqual([])
  })

  it('unregisters one source through the disposer register() returned', async () => {
    const { bloggers } = await mount()
    const dispose = bloggers.register(makeSource('alpha', () => false))
    bloggers.register(makeSource('beta', () => false))

    dispose()
    expect(bloggers.list().map(info => info.id)).toEqual(['beta'])
  })

  it('rejects a duplicate source id', async () => {
    const { bloggers } = await mount()
    bloggers.register(makeSource('alpha', () => false))
    expect(() => bloggers.register(makeSource('alpha', () => false)))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_SOURCE_DUPLICATE' }))
  })

  it('reports an unknown id with the registered ids, and (none) when none are registered', async () => {
    const { bloggers } = await mount()
    expect(() => bloggers.require('missing'))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_SOURCE_UNKNOWN', message: expect.stringContaining('(none)') as string }))

    bloggers.register(makeSource('alpha', () => false))
    expect(() => bloggers.require('missing'))
      .toThrow(expect.objectContaining({ message: expect.stringContaining('alpha') as string }))
  })

  it('looks a registered source up by id, and reports an absent id as undefined', async () => {
    const { bloggers } = await mount()
    const alpha = makeSource('alpha', () => false)
    bloggers.register(alpha)
    expect(bloggers.require('alpha')).toBe(alpha)
    expect(bloggers.get('alpha')).toBe(alpha)
    expect(bloggers.get('missing')).toBeUndefined()
  })
})

describe('blogger reference resolution', () => {
  it('resolves through the single source that recognizes the reference', async () => {
    const { bloggers } = await mount()
    bloggers.register(makeSource('alpha', input => input.startsWith('a:')))
    bloggers.register(makeSource('beta', input => input.startsWith('b:')))

    await expect(bloggers.resolve('b:42', testSignal))
      .resolves.toMatchObject({ source: { id: 'beta' }, ref: { source: 'beta', userID: 'resolved:b:42' } })
  })

  it('fails BLOGGER_SOURCE_UNRECOGNIZED when no source recognizes the reference', async () => {
    const { bloggers } = await mount()
    bloggers.register(makeSource('alpha', () => false))

    await expect(bloggers.resolve('nobody', testSignal))
      .rejects.toThrow(expect.objectContaining({ code: 'BLOGGER_SOURCE_UNRECOGNIZED' }))
  })

  it('fails BLOGGER_SOURCE_AMBIGUOUS when several sources recognize the reference', async () => {
    const { bloggers } = await mount()
    bloggers.register(makeSource('alpha', () => true))
    bloggers.register(makeSource('beta', () => true))

    await expect(bloggers.resolve('shared', testSignal))
      .rejects.toThrow(expect.objectContaining({
        code: 'BLOGGER_SOURCE_AMBIGUOUS',
        message: expect.stringContaining('alpha, beta') as string,
      }))
  })
})
