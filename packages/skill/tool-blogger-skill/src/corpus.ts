/**
 * The durable per-blogger corpus: its JSON record grammar, the merge that folds
 * one harvest into the accumulated record, and the file access that reads and
 * writes it through `ctx.fs`. The merge keeps the newest copy of a record and
 * preserves a body an earlier harvest already fetched, so re-harvesting a
 * blogger never discards work or duplicates a post.
 * @module @deepseek-ai/dsh-tool-blogger-skill/corpus
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BloggerReply } from '@deepseek-ai/dsh-blogger'
import type {} from '@deepseek-ai/dsh-fs'
import { BLOGGER_CORPUS_INVALID, BloggerSkillError } from './errors.ts'
import type { BloggerCorpus, CorpusPost } from './types.ts'

/** Bounds one corpus merge honors. */
export interface CorpusBounds {
  /** Maximum posts one corpus retains. */
  readonly maxCorpusPosts: number
  /** Maximum replies one corpus retains. */
  readonly maxCorpusReplies: number
}

/** One harvest's records, ready to merge into a stored corpus. */
export interface HarvestedCorpus {
  /** The source id that produced every record. */
  readonly source: string
  /** The blogger's user id on that source. */
  readonly userID: string
  /** Display name, when this harvest learned one. */
  readonly userName?: string
  /** Absolute profile page URL, when the source exposes one. */
  readonly profileUrl?: string
  /** ISO-8601 time of this harvest. */
  readonly updatedAt: string
  /** The 1-based post page this harvest started from. */
  readonly postStartPage: number
  /** The 1-based reply page this harvest started from. */
  readonly replyStartPage: number
  /** This harvest's posts, in platform list order. */
  readonly posts: CorpusPost[]
  /** This harvest's replies, in platform list order. */
  readonly replies: BloggerReply[]
}

/**
 * The corpus file path for one blogger. The name carries both the source id and
 * the source's own user id, so two platforms never collide.
 *
 * @param root - the configured corpus root directory.
 * @param source - the source id.
 * @param userID - the blogger's user id on that source.
 * @returns the absolute corpus file path.
 */
export function corpusPath(root: string, source: string, userID: string): string {
  return join(root, `${source}-${userID}.json`)
}

/**
 * Where one harvested window sits relative to the stored list. A window that
 * starts at the platform's first page carries the newest material and belongs at
 * the front; a window that starts past it continues the list and belongs at the
 * end. Getting this wrong inverts the block order and makes the retention bound
 * drop the wrong records.
 */
export type MergePosition = 'start' | 'end'

/**
 * Fold one harvest's posts into the stored ones, keeping platform list order.
 * A harvested post that carries no body keeps the stored body.
 *
 * @param existing - the stored posts, in platform list order.
 * @param harvested - this harvest's posts, in the same order.
 * @param maxPosts - the retained-post bound, applied to the newest end.
 * @param position - whether this window precedes or continues the stored list.
 * @returns the merged posts, in platform list order.
 */
export function mergePosts(
  existing: readonly CorpusPost[],
  harvested: readonly CorpusPost[],
  maxPosts: number,
  position: MergePosition,
): CorpusPost[] {
  return (position === 'start' ? mergePostsAtStart(existing, harvested) : mergePostsAtEnd(existing, harvested))
    .slice(0, maxPosts)
}

/**
 * Fold one window harvested from the head of the list ahead of the stored posts.
 *
 * @param existing - the stored posts, in platform list order.
 * @param harvested - this harvest's posts, in the same order.
 * @returns the merged posts, this window first.
 */
function mergePostsAtStart(existing: readonly CorpusPost[], harvested: readonly CorpusPost[]): CorpusPost[] {
  const stale = new Map(existing.map(post => [post.id, post]))
  const merged = harvested.map((post) => {
    const previous = stale.get(post.id)
    stale.delete(post.id)
    if (post.bodyMarkdown !== undefined || previous?.bodyMarkdown === undefined) return post
    return { ...post, bodyMarkdown: previous.bodyMarkdown }
  })
  for (const post of stale.values()) merged.push(post)
  return merged
}

/**
 * Fold one window that continues past the stored posts after them.
 *
 * @param existing - the stored posts, in platform list order.
 * @param harvested - this harvest's posts, in the same order.
 * @returns the merged posts, this window last.
 */
function mergePostsAtEnd(existing: readonly CorpusPost[], harvested: readonly CorpusPost[]): CorpusPost[] {
  const incoming = new Map(harvested.map(post => [post.id, post]))
  const known = new Set(existing.map(post => post.id))
  const merged = existing.map((post) => {
    const fresh = incoming.get(post.id)
    if (fresh === undefined) return post
    return fresh.bodyMarkdown !== undefined || post.bodyMarkdown === undefined
      ? fresh
      : { ...fresh, bodyMarkdown: post.bodyMarkdown }
  })
  for (const post of harvested) if (!known.has(post.id)) merged.push(post)
  return merged
}

/**
 * Fold one harvest's replies into the stored ones, keeping platform list order.
 *
 * @param existing - the stored replies, in platform list order.
 * @param harvested - this harvest's replies, in the same order.
 * @param maxReplies - the retained-reply bound, applied to the newest end.
 * @param position - whether this window precedes or continues the stored list.
 * @returns the merged replies, in platform list order.
 */
export function mergeReplies(
  existing: readonly BloggerReply[],
  harvested: readonly BloggerReply[],
  maxReplies: number,
  position: MergePosition,
): BloggerReply[] {
  const merged = position === 'start'
    ? [...harvested, ...existing.filter(reply => !harvested.some(next => next.id === reply.id))]
    : mergeRepliesAtEnd(existing, harvested)
  return merged.slice(0, maxReplies)
}

/**
 * Fold one window that continues past the stored replies after them, replacing a
 * stored copy this window saw again.
 *
 * @param existing - the stored replies, in platform list order.
 * @param harvested - this harvest's replies, in the same order.
 * @returns the merged replies, this window last.
 */
function mergeRepliesAtEnd(existing: readonly BloggerReply[], harvested: readonly BloggerReply[]): BloggerReply[] {
  const incoming = new Map(harvested.map(reply => [reply.id, reply]))
  const known = new Set(existing.map(reply => reply.id))
  const merged = existing.map(reply => incoming.get(reply.id) ?? reply)
  for (const reply of harvested) if (!known.has(reply.id)) merged.push(reply)
  return merged
}

/**
 * Parse and validate one stored corpus record. A file that no longer matches the
 * grammar fails loud rather than yielding a half-trusted corpus.
 *
 * @param text - the file's UTF-8 content.
 * @param path - the file path, for failure messages.
 * @returns the validated corpus.
 */
export function parseCorpus(text: string, path: string): BloggerCorpus {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new BloggerSkillError(`blogger corpus ${path} is not valid JSON`, BLOGGER_CORPUS_INVALID, { cause: error })
  }
  const record = asRecord(value, path)
  const userName = optionalText(record, 'userName', path)
  const profileUrl = optionalText(record, 'profileUrl', path)
  return {
    source: textField(record, 'source', path),
    userID: textField(record, 'userID', path),
    updatedAt: textField(record, 'updatedAt', path),
    ...userName === undefined ? {} : { userName },
    ...profileUrl === undefined ? {} : { profileUrl },
    posts: arrayField(record, 'posts', path).map((item, index) => parsePost(item, `${path} posts[${index}]`)),
    replies: arrayField(record, 'replies', path).map((item, index) => parseReply(item, `${path} replies[${index}]`)),
  }
}

/**
 * Serialize one corpus for storage.
 *
 * @param corpus - the corpus to serialize.
 * @returns the JSON text, indented for a readable diff.
 */
export function serializeCorpus(corpus: BloggerCorpus): string {
  return `${JSON.stringify(corpus, undefined, 2)}\n`
}

/** Reads and writes one blogger's corpus under the configured root. */
export class BloggerCorpusStore {
  /**
   * @param ctx - context exposing the filesystem service.
   * @param root - the configured corpus root directory.
   * @param bounds - the retained-post and retained-reply bounds.
   */
  constructor(
    private readonly ctx: Context,
    private readonly root: string,
    private readonly bounds: CorpusBounds,
  ) {}

  /**
   * The corpus file path this store reads and writes for one blogger.
   *
   * @param source - the source id.
   * @param userID - the blogger's user id on that source.
   * @returns the absolute corpus file path.
   */
  pathFor(source: string, userID: string): string {
    return corpusPath(this.root, source, userID)
  }

  /**
   * Read one blogger's stored corpus.
   *
   * @param source - the source id.
   * @param userID - the blogger's user id on that source.
   * @param signal - cancellation signal.
   * @returns the stored corpus, or `undefined` when no harvest has written one.
   */
  async read(source: string, userID: string, signal: AbortSignal): Promise<BloggerCorpus | undefined> {
    const path = this.pathFor(source, userID)
    const target = await this.ctx.fs.resolve(path, { signal })
    if (await this.ctx.fs.stat(target, signal) === undefined) return undefined
    return parseCorpus(await this.ctx.fs.readText(target, signal), path)
  }

  /**
   * Merge one harvest into the stored corpus and write the result back.
   *
   * @param stored - the corpus already on disk, when one exists.
   * @param harvested - this harvest's identity and records.
   * @param signal - cancellation signal.
   * @returns the corpus as written.
   */
  async merge(
    stored: BloggerCorpus | undefined,
    harvested: HarvestedCorpus,
    signal: AbortSignal,
  ): Promise<BloggerCorpus> {
    const userName = harvested.userName ?? stored?.userName
    const profileUrl = harvested.profileUrl ?? stored?.profileUrl
    const corpus: BloggerCorpus = {
      source: harvested.source,
      userID: harvested.userID,
      updatedAt: harvested.updatedAt,
      ...userName === undefined ? {} : { userName },
      ...profileUrl === undefined ? {} : { profileUrl },
      posts: mergePosts(
        stored?.posts ?? [],
        harvested.posts,
        this.bounds.maxCorpusPosts,
        harvested.postStartPage === 1 ? 'start' : 'end',
      ),
      replies: mergeReplies(
        stored?.replies ?? [],
        harvested.replies,
        this.bounds.maxCorpusReplies,
        harvested.replyStartPage === 1 ? 'start' : 'end',
      ),
    }
    const target = await this.ctx.fs.resolve(this.pathFor(corpus.source, corpus.userID), { signal })
    await this.ctx.fs.writeText(target, serializeCorpus(corpus), undefined, signal)
    return corpus
  }
}

/**
 * Require one value to be a plain JSON object.
 *
 * @param value - the parsed JSON value.
 * @param where - the location, for failure messages.
 * @returns the value as a string-keyed record.
 */
function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BloggerSkillError(`${where} is not a JSON object`, BLOGGER_CORPUS_INVALID)
  }
  return value as Record<string, unknown>
}

/**
 * Require one non-empty string field.
 *
 * @param record - the containing record.
 * @param key - the field name.
 * @param where - the record's location, for failure messages.
 * @returns the field's value.
 */
function textField(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BloggerSkillError(`${where} has no "${key}" string`, BLOGGER_CORPUS_INVALID)
  }
  return value
}

/**
 * Read one optional string field.
 *
 * @param record - the containing record.
 * @param key - the field name.
 * @param where - the record's location, for failure messages.
 * @returns the field's value, or `undefined` when the field is absent.
 */
function optionalText(record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new BloggerSkillError(`${where} field "${key}" is not a string`, BLOGGER_CORPUS_INVALID)
  }
  return value
}

/**
 * Read one optional numeric field.
 *
 * @param record - the containing record.
 * @param key - the field name.
 * @param where - the record's location, for failure messages.
 * @returns the field's value, or `undefined` when the field is absent.
 */
function optionalNumber(record: Record<string, unknown>, key: string, where: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number') {
    throw new BloggerSkillError(`${where} field "${key}" is not a number`, BLOGGER_CORPUS_INVALID)
  }
  return value
}

/**
 * Require one array field.
 *
 * @param record - the containing record.
 * @param key - the field name.
 * @param where - the record's location, for failure messages.
 * @returns the field's items.
 */
function arrayField(record: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    throw new BloggerSkillError(`${where} has no "${key}" array`, BLOGGER_CORPUS_INVALID)
  }
  return value
}

/**
 * Validate one stored post record.
 *
 * @param value - the stored item.
 * @param where - the item's location, for failure messages.
 * @returns the validated post.
 */
function parsePost(value: unknown, where: string): CorpusPost {
  const record = asRecord(value, where)
  const body = optionalText(record, 'bodyMarkdown', where)
  const replies = optionalNumber(record, 'replies', where)
  const views = optionalNumber(record, 'views', where)
  const likes = optionalNumber(record, 'likes', where)
  return {
    id: textField(record, 'id', where),
    url: textField(record, 'url', where),
    title: textField(record, 'title', where),
    publishedAt: textField(record, 'publishedAt', where),
    ...body === undefined ? {} : { bodyMarkdown: body },
    ...replies === undefined ? {} : { replies },
    ...views === undefined ? {} : { views },
    ...likes === undefined ? {} : { likes },
  }
}

/**
 * Validate one stored reply record.
 *
 * @param value - the stored item.
 * @param where - the item's location, for failure messages.
 * @returns the validated reply.
 */
function parseReply(value: unknown, where: string): BloggerReply {
  const record = asRecord(value, where)
  const likes = optionalNumber(record, 'likes', where)
  return {
    id: textField(record, 'id', where),
    url: textField(record, 'url', where),
    topicTitle: textField(record, 'topicTitle', where),
    topicUrl: textField(record, 'topicUrl', where),
    repliedAt: textField(record, 'repliedAt', where),
    body: textField(record, 'body', where),
    ...likes === undefined ? {} : { likes },
  }
}
