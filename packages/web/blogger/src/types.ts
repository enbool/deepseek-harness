/**
 * The blogger source vocabulary: one blogger's identity on one platform, the
 * posts and replies a source collects for that identity, and the contract every
 * platform implementation satisfies. Pure types only — no runtime code. Display
 * strings (times, counters) are passed through verbatim as the platform renders
 * them rather than re-parsed into timestamps.
 * @module @deepseek-ai/dsh-blogger/types
 */

/** One blogger's identity as one source resolved it. */
export interface BloggerRef {
  /** The source id that resolved this blogger, for example `tgb`. */
  readonly source: string
  /** The platform's own user id, verbatim. */
  readonly userID: string
  /** Display name, when the resolving source knows it without a further request. */
  readonly userName?: string
  /** Absolute profile page URL, when the platform has one. */
  readonly profileUrl?: string
}

/** One long-form post (主贴) without its body. */
export interface BloggerPostSummary {
  /** The source's own post identity, accepted by {@link BloggerSource.fetchPost}. */
  readonly id: string
  /** Absolute post URL. */
  readonly url: string
  /** Post title. */
  readonly title: string
  /** Publication time, verbatim as the platform renders it. */
  readonly publishedAt: string
  /** Reply count, when the platform exposes it. */
  readonly replies?: number
  /** View count, when the platform exposes it. */
  readonly views?: number
  /** Like count, when the platform exposes it. */
  readonly likes?: number
}

/** One long-form post with its body converted to markdown. */
export interface BloggerPost extends BloggerPostSummary {
  /** The post body as markdown. */
  readonly bodyMarkdown: string
}

/** One reply (跟帖) the blogger wrote under another user's post. */
export interface BloggerReply {
  /** The source's own reply identity. */
  readonly id: string
  /** Absolute URL anchoring this reply inside its topic. */
  readonly url: string
  /** Title of the post this reply sits under. */
  readonly topicTitle: string
  /** Absolute URL of the post this reply sits under. */
  readonly topicUrl: string
  /** Reply time, verbatim as the platform renders it. */
  readonly repliedAt: string
  /** Reply body text. */
  readonly body: string
  /** Like count, when the platform exposes it. */
  readonly likes?: number
}

/** One source's collected slice of a list, with the pagination facts a caller reports. */
export interface BloggerPage<T> {
  /** The collected items, in platform order. */
  readonly items: T[]
  /** The 1-based page the collection started from. */
  readonly pageNo: number
  /** How many pages the source actually fetched. */
  readonly pagesFetched: number
  /** Whether the platform held further items when collection stopped. */
  readonly hasMore: boolean
}

/** One bounded list request a source collects against. */
export interface BloggerListRequest {
  /** The 1-based page to start from. */
  readonly pageNo: number
  /** How many pages this call may fetch, inclusive. */
  readonly maxPages: number
  /** Cancellation signal the source forwards to every platform request. */
  readonly signal: AbortSignal
}

/**
 * One platform's blogger data access. A platform package registers one
 * implementation on `ctx.bloggers`; a consumer resolves a user's id-or-homepage
 * reference to a {@link BloggerRef} and then collects through this interface.
 *
 * `matches` and `resolve` must agree: `resolve` accepts exactly the references
 * `matches` accepted. Collection methods receive only a reference this source
 * itself produced, so they re-derive nothing from the original user input.
 */
export interface BloggerSource {
  /** Registry key: lower-case, stable, and unique across registered sources. */
  readonly id: string
  /** Human-readable platform name for model-facing and diagnostic text. */
  readonly displayName: string
  /**
   * Whether this source can interpret one user reference, which may be a
   * platform id or a profile URL. A pure syntactic test: it performs no I/O.
   *
   * @param input - the caller's raw user reference.
   * @returns true when {@link BloggerSource.resolve} accepts the same reference.
   */
  matches(input: string): boolean
  /**
   * Resolve one user reference to a canonical identity.
   *
   * @param input - the caller's raw user reference, accepted by {@link BloggerSource.matches}.
   * @param signal - cancellation signal.
   * @returns the resolved identity.
   */
  resolve(input: string, signal: AbortSignal): Promise<BloggerRef>
  /**
   * Collect one bounded slice of this blogger's posts, newest first as the
   * platform orders them.
   *
   * @param ref - an identity this source resolved.
   * @param request - the start page, page budget, and cancellation signal.
   * @returns the collected summaries with their pagination facts.
   */
  listPosts(ref: BloggerRef, request: BloggerListRequest): Promise<BloggerPage<BloggerPostSummary>>
  /**
   * Fetch one post's body.
   *
   * @param ref - an identity this source resolved.
   * @param postId - a {@link BloggerPostSummary.id} from this source.
   * @param signal - cancellation signal.
   * @returns the post with its body as markdown.
   */
  fetchPost(ref: BloggerRef, postId: string, signal: AbortSignal): Promise<BloggerPost>
  /**
   * Collect one bounded slice of this blogger's replies on other users' posts.
   *
   * @param ref - an identity this source resolved.
   * @param request - the start page, page budget, and cancellation signal.
   * @returns the collected replies with their pagination facts.
   */
  listReplies(ref: BloggerRef, request: BloggerListRequest): Promise<BloggerPage<BloggerReply>>
}

/** One registered source, as the registry reports it for discovery. */
export interface BloggerSourceInfo {
  /** The source id. */
  readonly id: string
  /** The source's human-readable platform name. */
  readonly displayName: string
}

/** The source and identity one user reference resolved to. */
export interface BloggerResolution {
  /** The source that recognized the reference. */
  readonly source: BloggerSource
  /** The blogger's identity on that source. */
  readonly ref: BloggerRef
}
