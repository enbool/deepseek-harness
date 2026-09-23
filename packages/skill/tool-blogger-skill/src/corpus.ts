/**
 * The durable per-blogger corpus: its JSON record grammar, the merge that folds
 * one intake into the accumulated record, and the file access that reads and
 * writes it through `ctx.fs`. The merge keeps the newest copy of a record and
 * preserves a body an earlier harvest already fetched, so re-harvesting or
 * re-ingesting a blogger never discards work or duplicates a record.
 * @module @deepseek-ai/dsh-tool-blogger-skill/corpus
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { BLOGGER_CORPUS_INVALID, BloggerSkillError } from './errors.ts'
import type { BloggerCorpus, CorpusOrigin, CorpusPost, CorpusReply } from './types.ts'

/** Bounds one platform harvest merge honors. */
export interface CorpusBounds {
  /** Maximum platform posts one corpus retains. */
  readonly maxCorpusPosts: number
  /** Maximum platform replies one corpus retains. */
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
  readonly replies: CorpusReply[]
}

/** One document intake's records, ready to fold into a stored corpus. */
export interface IngestedCorpus {
  /** The source id the intake belongs to. */
  readonly source: string
  /** The blogger's user id on that source. */
  readonly userID: string
  /** Display name, when this intake learned one. */
  readonly userName?: string
  /** ISO-8601 time of this intake. */
  readonly updatedAt: string
  /** The documents' records, in the order the intake read them. */
  readonly posts: CorpusPost[]
  /** The documents' replies, in the order the intake read them. */
  readonly replies: CorpusReply[]
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
  const merged = position === 'start' ? mergePostsAtStart(existing, harvested) : mergePostsAtEnd(existing, harvested)
  return capEntries(merged, maxPosts, post => post.origin)
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
  existing: readonly CorpusReply[],
  harvested: readonly CorpusReply[],
  maxReplies: number,
  position: MergePosition,
): CorpusReply[] {
  const merged = position === 'start'
    ? [...harvested, ...existing.filter(reply => !harvested.some(next => next.id === reply.id))]
    : mergeRepliesAtEnd(existing, harvested)
  return capEntries(merged, maxReplies, reply => reply.origin)
}

/**
 * Fold one window that continues past the stored replies after them, replacing a
 * stored copy this window saw again.
 *
 * @param existing - the stored replies, in platform list order.
 * @param harvested - this harvest's replies, in the same order.
 * @returns the merged replies, this window last.
 */
function mergeRepliesAtEnd(existing: readonly CorpusReply[], harvested: readonly CorpusReply[]): CorpusReply[] {
  const incoming = new Map(harvested.map(reply => [reply.id, reply]))
  const known = new Set(existing.map(reply => reply.id))
  const merged = existing.map(reply => incoming.get(reply.id) ?? reply)
  for (const reply of harvested) if (!known.has(reply.id)) merged.push(reply)
  return merged
}

/**
 * Apply the retention bound to the platform entries only. Offline entries are an
 * explicit intake of documents the user chose, not automatic growth, so dropping
 * them silently would lose the material the user came for.
 *
 * @param entries - the merged entries, newest first.
 * @param max - the bound on platform entries.
 * @param originOf - reads one entry's origin.
 * @returns every offline entry, plus the newest `max` platform entries.
 */
function capEntries<T extends { readonly id: string }>(
  entries: readonly T[],
  max: number,
  originOf: (entry: T) => CorpusOrigin | undefined,
): T[] {
  const kept = new Set(entries.filter(entry => originOf(entry) !== 'offline').slice(0, max).map(entry => entry.id))
  return entries.filter(entry => originOf(entry) === 'offline' || kept.has(entry.id))
}

/**
 * Fold one document intake into the stored records. A record already stored under
 * the same id is replaced rather than duplicated, so re-ingesting an unchanged
 * document is idempotent, and a record whose document carries a date lands at
 * that date's place in the list.
 *
 * @param existing - the stored records, newest first.
 * @param ingested - the documents' records.
 * @param dateOf - reads one record's rendered timestamp.
 * @returns the merged records, newest first.
 */
export function mergeDocuments<T extends { readonly id: string }>(
  existing: readonly T[],
  ingested: readonly T[],
  dateOf: (entry: T) => string,
): T[] {
  const incoming = new Set(ingested.map(entry => entry.id))
  return insertByDate(existing.filter(entry => !incoming.has(entry.id)), ingested, dateOf)
}

/**
 * Insert records into an ordered list at their date's place, leaving every stored
 * record where it already sits.
 *
 * @param existing - the ordered records.
 * @param added - the records to place.
 * @param dateOf - reads one record's rendered timestamp.
 * @returns the merged records in date order.
 */
function insertByDate<T>(
  existing: readonly T[],
  added: readonly T[],
  dateOf: (entry: T) => string,
): T[] {
  const merged = [...existing]
  for (const entry of added) {
    const at = merged.findIndex(candidate => compareByDate(dateOf(entry), dateOf(candidate)) < 0)
    merged.splice(at === -1 ? merged.length : at, 0, entry)
  }
  return merged
}

/**
 * Order two rendered timestamps newest first, placing one that carries no date
 * after every dated record.
 *
 * @param left - the first timestamp.
 * @param right - the second timestamp.
 * @returns a negative number when the first is newer.
 */
function compareByDate(left: string, right: string): number {
  const leftKey = dateKey(left)
  const rightKey = dateKey(right)
  if (leftKey === rightKey) return 0
  if (leftKey === undefined) return 1
  if (rightKey === undefined) return -1
  return leftKey > rightKey ? -1 : 1
}

/**
 * Read the ISO date a rendered timestamp carries.
 *
 * @param value - the rendered timestamp.
 * @returns the leading `YYYY-MM-DD`, or `undefined` when it carries none.
 */
function dateKey(value: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2})/u.exec(value)?.[1]
}

/**
 * Parse and validate one stored corpus record. A file that no longer matches the
 * grammar fails loud rather than yielding a half-trusted corpus. A record written
 * before the corpus carried the origin field reads as a platform record, which is what
 * every record predating document intake was.
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
   * @returns the stored corpus, or `undefined` when no intake has written one.
   */
  async read(source: string, userID: string, signal: AbortSignal): Promise<BloggerCorpus | undefined> {
    const path = this.pathFor(source, userID)
    const target = await this.ctx.fs.resolve(path, { signal })
    if (await this.ctx.fs.stat(target, signal) === undefined) return undefined
    return parseCorpus(await this.ctx.fs.readText(target, signal), path)
  }

  /**
   * Merge one platform harvest into the stored corpus and write the result back.
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
    return this.write({
      ...identity(harvested.source, harvested.userID, harvested.userName ?? stored?.userName, harvested.profileUrl ?? stored?.profileUrl),
      updatedAt: harvested.updatedAt,
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
    }, signal)
  }

  /**
   * Merge one document intake into the stored corpus and write the result back.
   * The intake carries no page window, so nothing is dropped by the platform
   * retention bound and the stored order survives.
   *
   * @param stored - the corpus already on disk, when one exists.
   * @param ingested - this intake's identity and records.
   * @param signal - cancellation signal.
   * @returns the corpus as written.
   */
  async ingest(
    stored: BloggerCorpus | undefined,
    ingested: IngestedCorpus,
    signal: AbortSignal,
  ): Promise<BloggerCorpus> {
    return this.write({
      ...identity(ingested.source, ingested.userID, ingested.userName ?? stored?.userName, stored?.profileUrl),
      updatedAt: ingested.updatedAt,
      posts: mergeDocuments(stored?.posts ?? [], ingested.posts, post => post.publishedAt),
      replies: mergeDocuments(stored?.replies ?? [], ingested.replies, reply => reply.repliedAt),
    }, signal)
  }

  /**
   * Write one corpus back to its file.
   *
   * @param corpus - the corpus to store.
   * @param signal - cancellation signal.
   * @returns the corpus as written.
   */
  private async write(corpus: BloggerCorpus, signal: AbortSignal): Promise<BloggerCorpus> {
    const target = await this.ctx.fs.resolve(this.pathFor(corpus.source, corpus.userID), { signal })
    await this.ctx.fs.writeText(target, serializeCorpus(corpus), undefined, signal)
    return corpus
  }
}

/**
 * Build one corpus identity, omitting the optional fields the intake did not learn.
 *
 * @param source - the source id.
 * @param userID - the blogger's user id on that source.
 * @param userName - the display name, when known.
 * @param profileUrl - the profile page URL, when known.
 * @returns the identity fields of a corpus record.
 */
function identity(
  source: string,
  userID: string,
  userName: string | undefined,
  profileUrl: string | undefined,
): Pick<BloggerCorpus, 'source' | 'userID' | 'userName' | 'profileUrl'> {
  return {
    source,
    userID,
    ...userName === undefined ? {} : { userName },
    ...profileUrl === undefined ? {} : { profileUrl },
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
 * Read the intake that produced one record. A record written before the field
 * existed reads as a platform record; a record carrying anything else fails loud.
 *
 * @param record - the containing record.
 * @param where - the record's location, for failure messages.
 * @returns the recorded origin, or `undefined` when the field is absent.
 */
function optionalOrigin(record: Record<string, unknown>, where: string): CorpusOrigin | undefined {
  const value = record['origin']
  if (value === undefined) return undefined
  if (value !== 'platform' && value !== 'offline') {
    throw new BloggerSkillError(`${where} field "origin" is not "platform" or "offline"`, BLOGGER_CORPUS_INVALID)
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
  const documentPath = optionalText(record, 'documentPath', where)
  const origin = optionalOrigin(record, where)
  const replies = optionalNumber(record, 'replies', where)
  const views = optionalNumber(record, 'views', where)
  const likes = optionalNumber(record, 'likes', where)
  return {
    id: textField(record, 'id', where),
    url: textField(record, 'url', where),
    title: textField(record, 'title', where),
    publishedAt: textField(record, 'publishedAt', where),
    ...origin === undefined ? {} : { origin },
    ...body === undefined ? {} : { bodyMarkdown: body },
    ...documentPath === undefined ? {} : { documentPath },
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
function parseReply(value: unknown, where: string): CorpusReply {
  const record = asRecord(value, where)
  const documentPath = optionalText(record, 'documentPath', where)
  const origin = optionalOrigin(record, where)
  const likes = optionalNumber(record, 'likes', where)
  return {
    id: textField(record, 'id', where),
    url: textField(record, 'url', where),
    topicTitle: textField(record, 'topicTitle', where),
    topicUrl: textField(record, 'topicUrl', where),
    repliedAt: textField(record, 'repliedAt', where),
    body: textField(record, 'body', where),
    ...origin === undefined ? {} : { origin },
    ...documentPath === undefined ? {} : { documentPath },
    ...likes === undefined ? {} : { likes },
  }
}
