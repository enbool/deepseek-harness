/**
 * The durable harvest record and the distilled profile. Pure types only — no
 * runtime code. A corpus accumulates across harvests so a later distillation
 * sees everything earlier harvests collected for the same blogger.
 * @module @deepseek-ai/dsh-tool-blogger-skill/types
 */

import type { BloggerPostSummary, BloggerReply } from '@deepseek-ai/dsh-blogger'

/** Which intake produced one corpus record. */
export type CorpusOrigin = 'platform' | 'offline'

/** One harvested post: its summary plus the body once a harvest or an ingest supplied it. */
export interface CorpusPost extends BloggerPostSummary {
  /** The post body as markdown, absent until a harvest fetched it or a document carried it. */
  readonly bodyMarkdown?: string
  /** Which intake produced this record; absent on a record written before the field existed, which means platform. */
  readonly origin?: CorpusOrigin
  /** The local document this record came from, when it is offline. */
  readonly documentPath?: string
}

/** One harvested reply, carrying the intake that produced it. */
export interface CorpusReply extends BloggerReply {
  /** Which intake produced this record; absent on a record written before the field existed, which means platform. */
  readonly origin?: CorpusOrigin
  /** The local document this record came from, when it is offline. */
  readonly documentPath?: string
}

/** One blogger's durable harvest, keyed by source and user id. */
export interface BloggerCorpus {
  /** The source id that produced every platform record here. */
  readonly source: string
  /** The blogger's user id on that source. */
  readonly userID: string
  /** Display name, once any harvest learned it. */
  readonly userName?: string
  /** Absolute profile page URL, when the source exposes one. */
  readonly profileUrl?: string
  /** ISO-8601 time of the intake that last wrote this corpus. */
  readonly updatedAt: string
  /** Posts, newest first. */
  readonly posts: CorpusPost[]
  /** Replies, newest first. */
  readonly replies: CorpusReply[]
}

/** The distilled skill a model returns: the operating procedure plus its evidence. */
export interface BloggerProfile {
  /** Kebab-case skill name; the skill file's directory name. */
  readonly name: string
  /** One-line skill description, used for discovery. */
  readonly description: string
  /** The operating procedure: the blogger's rules as imperative, actionable markdown. */
  readonly skill: string
  /** The evidence portrait: worldview, recurring arguments, quotes, dates, and cases. */
  readonly portrait: string
}
