/**
 * Offline documents as corpus records. A platform harvest can only see what the
 * platform still carries, so a deleted post is invisible to it however important
 * it was; a document the reader saved is the only remaining copy. This module
 * reads one markdown document — optional YAML frontmatter, then the body — and
 * maps it to the corpus record it becomes.
 * @module @deepseek-ai/dsh-tool-blogger-skill/documents
 */

import { basename } from 'node:path'
import { BLOGGER_DOCUMENT_INVALID, BloggerSkillError } from './errors.ts'
import type { CorpusPost, CorpusReply } from './types.ts'

/** What one document holds. */
export type DocumentKind = 'post' | 'reply'

/** The timestamp a document that carries no date renders with. */
export const UNKNOWN_DATE = '日期不详'

/** One offline document, read and classified. */
export interface IngestedDocument {
  /** The path the document was read from, as given to the tool. */
  readonly path: string
  /** The document's title. */
  readonly title: string
  /** The document's rendered timestamp, or {@link UNKNOWN_DATE}. */
  readonly publishedAt: string
  /** Whether the document is a post or a reply. */
  readonly kind: DocumentKind
  /** The platform id this document carries, when the reader supplied one. */
  readonly platformId?: string
  /** The topic a reply answers, when the document names one. */
  readonly topicTitle?: string
  /** The topic URL a reply answers, when the document names one. */
  readonly topicUrl?: string
  /** The document's body markdown. */
  readonly bodyMarkdown: string
}

/**
 * Read one markdown document: its optional frontmatter and its body. Recognized
 * fields are `title`, `publishedAt`, `kind`, `platformId`, `topicTitle`, and
 * `topicUrl`; every other field is ignored so a document may carry its own
 * bookkeeping.
 *
 * @param path - the path the document was read from.
 * @param text - the document's UTF-8 content.
 * @param fallbackKind - the kind to use when the frontmatter names none.
 * @returns the classified document.
 */
export function parseDocument(path: string, text: string, fallbackKind: DocumentKind): IngestedDocument {
  const { fields, body } = splitFrontmatter(text)
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    throw new BloggerSkillError(`blogger document ${path} has no body`, BLOGGER_DOCUMENT_INVALID)
  }
  const kind = fields['kind'] ?? fallbackKind
  if (kind !== 'post' && kind !== 'reply') {
    throw new BloggerSkillError(
      `blogger document ${path} declares kind "${kind}", which is neither "post" nor "reply"`,
      BLOGGER_DOCUMENT_INVALID,
    )
  }
  const platformId = fields['platformId']
  const topicTitle = fields['topicTitle']
  const topicUrl = fields['topicUrl']
  const publishedAt = fields['publishedAt']
  return {
    path,
    title: fields['title'] ?? headingOrFilename(path, trimmed),
    publishedAt: publishedAt ?? UNKNOWN_DATE,
    kind,
    ...platformId === undefined ? {} : { platformId },
    ...topicTitle === undefined ? {} : { topicTitle },
    ...topicUrl === undefined ? {} : { topicUrl },
    bodyMarkdown: trimmed,
  }
}

/**
 * Map one document to the post record it becomes.
 *
 * @param document - the classified document.
 * @returns the corpus post.
 */
export function documentPost(document: IngestedDocument): CorpusPost {
  return {
    id: document.platformId ?? offlineId(document),
    url: document.path,
    title: document.title,
    publishedAt: document.publishedAt,
    bodyMarkdown: document.bodyMarkdown,
    origin: 'offline',
    documentPath: document.path,
  }
}

/**
 * Map one document to the reply record it becomes.
 *
 * @param document - the classified document.
 * @returns the corpus reply.
 */
export function documentReply(document: IngestedDocument): CorpusReply {
  return {
    id: document.platformId ?? offlineId(document),
    url: document.topicUrl ?? document.path,
    topicTitle: document.topicTitle ?? document.title,
    topicUrl: document.topicUrl ?? document.path,
    repliedAt: document.publishedAt,
    body: document.bodyMarkdown,
    origin: 'offline',
    documentPath: document.path,
  }
}

/**
 * The corpus id one document owns. It derives from the path, so re-ingesting the
 * same document replaces its record instead of appending a second copy.
 *
 * @param document - the classified document.
 * @returns the record id.
 */
function offlineId(document: IngestedDocument): string {
  return `offline:${document.path}`
}

/**
 * Split one document into its frontmatter fields and its body.
 *
 * @param text - the document's UTF-8 content.
 * @returns the recognized fields and the remaining body.
 */
function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/u.exec(text)
  if (match === null) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  /* v8 ignore next -- capture group 1 always participates when the pattern matches. */
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = unquote(line.slice(separator + 1).trim())
    if (key.length > 0 && value.length > 0) fields[key] = value
  }
  return { fields, body: text.slice(match[0].length) }
}

/**
 * Remove one layer of matching quotes from a frontmatter value.
 *
 * @param value - the raw value.
 * @returns the value without its surrounding quotes.
 */
function unquote(value: string): string {
  const match = /^(["'])([\s\S]*)\1$/u.exec(value)
  return match?.[2] ?? value
}

/**
 * Title one document from its own first heading, or from its file name.
 *
 * @param path - the path the document was read from.
 * @param body - the document's body.
 * @returns the title.
 */
function headingOrFilename(path: string, body: string): string {
  const heading = /^#[ \t]+(.+)$/mu.exec(body)
  if (heading?.[1] !== undefined) return heading[1].trim()
  return basename(path).replace(/\.[^.]*$/u, '')
}
