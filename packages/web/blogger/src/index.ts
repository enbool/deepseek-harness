/**
 * Service Definition for the blogger source seam (`ctx.bloggers`). A platform
 * package registers one {@link BloggerSource}; a consumer resolves a user's
 * id-or-homepage reference against the registered sources and then collects
 * that blogger's posts and replies through the winner.
 *
 * Resolution never depends on registration order: the reference itself selects
 * the source, and two sources recognizing one reference is a fail-loud
 * ambiguity rather than a silent first-wins.
 * @module @deepseek-ai/dsh-blogger
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  BLOGGER_SOURCE_AMBIGUOUS,
  BLOGGER_SOURCE_DUPLICATE,
  BLOGGER_SOURCE_UNKNOWN,
  BLOGGER_SOURCE_UNRECOGNIZED,
  BloggerError,
} from './errors.ts'
import type { BloggerResolution, BloggerSource, BloggerSourceInfo } from './types.ts'

export {
  BLOGGER_REFERENCE_INVALID,
  BLOGGER_SOURCE_AMBIGUOUS,
  BLOGGER_SOURCE_DUPLICATE,
  BLOGGER_SOURCE_UNKNOWN,
  BLOGGER_SOURCE_UNRECOGNIZED,
  BloggerError,
} from './errors.ts'
export type {
  BloggerListRequest,
  BloggerPage,
  BloggerPost,
  BloggerPostSummary,
  BloggerRef,
  BloggerReply,
  BloggerResolution,
  BloggerSource,
  BloggerSourceInfo,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    bloggers: BloggerSourceRegistry
  }
}

/**
 * The blogger source registry, registered as `ctx.bloggers` (one instance per
 * context). It owns the set of platform sources, their ids, and their lifetime.
 */
export class BloggerSourceRegistry extends Service {
  private readonly sources = new Map<string, BloggerSource>()

  /**
   * @param ctx - the context this registry is registered on.
   */
  constructor(ctx: Context) {
    super(ctx, 'bloggers')
  }

  /**
   * Register one platform source. Throws {@link BloggerError}
   * `BLOGGER_SOURCE_DUPLICATE` when its id is already registered.
   *
   * @param source - the source; its `id` is the registry key.
   * @returns the disposer that unregisters the source.
   */
  register(source: BloggerSource): () => void {
    const sources = this.sources
    if (sources.has(source.id)) {
      throw new BloggerError(`a blogger source with id "${source.id}" is already registered`, BLOGGER_SOURCE_DUPLICATE)
    }
    const dispose = this.ctx.effect(function* () {
      sources.set(source.id, source)
      yield () => sources.delete(source.id)
    }, 'bloggers.register()')
    // ctx.effect's disposer returns Promise<void>; this API is synchronous
    // fire-and-forget, and the effect body resolves without awaiting anything.
    return () => void dispose()
  }

  /**
   * Report every registered source for discovery.
   *
   * @returns one entry per registered source, in registration order.
   */
  list(): BloggerSourceInfo[] {
    return [...this.sources.values()].map(source => ({ id: source.id, displayName: source.displayName }))
  }

  /**
   * Look up one source by id.
   *
   * @param id - the source id to look up.
   * @returns the source, or `undefined` when no source carries that id.
   */
  get(id: string): BloggerSource | undefined {
    return this.sources.get(id)
  }

  /**
   * Resolve one source by id, failing loud when it is absent.
   *
   * @param id - the source id a caller named explicitly.
   * @returns the registered source.
   */
  require(id: string): BloggerSource {
    const source = this.sources.get(id)
    if (source === undefined) {
      const known = this.list().map(info => info.id).join(', ')
      throw new BloggerError(
        `blogger source "${id}" is not registered; registered sources: ${known.length === 0 ? '(none)' : known}`,
        BLOGGER_SOURCE_UNKNOWN,
      )
    }
    return source
  }

  /**
   * Resolve a user's id-or-homepage reference to one source's identity. Exactly
   * one registered source must recognize the reference; none, or more than one,
   * fails with the matching {@link BloggerError} code.
   *
   * @param input - the caller's raw user reference.
   * @param signal - cancellation signal forwarded to the resolving source.
   * @returns the recognizing source and the identity it resolved.
   */
  async resolve(input: string, signal: AbortSignal): Promise<BloggerResolution> {
    const matches = [...this.sources.values()].filter(source => source.matches(input))
    const single = matches[0]
    if (single === undefined) {
      throw new BloggerError(
        `no registered blogger source recognizes "${input}"`,
        BLOGGER_SOURCE_UNRECOGNIZED,
      )
    }
    if (matches.length > 1) {
      throw new BloggerError(
        `blogger reference "${input}" is recognized by several sources (${matches.map(source => source.id).join(', ')}); name one source explicitly`,
        BLOGGER_SOURCE_AMBIGUOUS,
      )
    }
    return { source: single, ref: await single.resolve(input, signal) }
  }
}

export default BloggerSourceRegistry
