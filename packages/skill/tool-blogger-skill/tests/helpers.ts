/**
 * Shared test scaffolding for the blogger-skill tools: a stub platform source,
 * a scripted LLM adapter, a temp workspace for the corpus and skill roots, and
 * the chunk helpers those two use.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BloggerListRequest,
  BloggerPage,
  BloggerPost,
  BloggerPostSummary,
  BloggerRef,
  BloggerReply,
  BloggerSource,
} from '@deepseek-ai/dsh-blogger'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { EVIDENCE_MARKER, EVIDENCE_SYSTEM_PROMPT, PROCEDURE_MARKER } from '../src/profile.ts'

/** Build a text-only response stream. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** An LLM adapter answering every request with one scripted finish. */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.script) yield chunk
  }
}

/** An LLM adapter that answers the evidence pass and the merge pass differently. */
export class RoutingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly evidence = '### 情绪周期\n- 追涨杀跌（2011-04-13）',
    private readonly profile = profileAnswer(),
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const answer = options.system === EVIDENCE_SYSTEM_PROMPT ? this.evidence : this.profile
    for (const chunk of textResponse(answer)) yield chunk
  }
}

/** The identity facts a {@link StubBloggerSource} reports, when it knows them. */
export interface StubIdentity {
  /** Display name, omitted when the platform does not expose one. */
  readonly name?: string
  /** Whether the platform exposes a profile page URL. */
  readonly withProfileUrl?: boolean
}

/** A platform source serving one fixed post and reply set. */
export class StubBloggerSource implements BloggerSource {
  readonly id = 'stub'
  readonly displayName = 'Stub Platform'
  /** Every collection call this source received, in order. */
  readonly calls: string[] = []

  constructor(
    private readonly posts: readonly BloggerPostSummary[],
    private readonly replies: readonly BloggerReply[],
    private readonly identity: StubIdentity = { name: 'Stub Blogger', withProfileUrl: true },
    private readonly hasMore = false,
  ) {}

  matches(input: string): boolean {
    return /^\d+$/u.test(input) || input.startsWith('https://stub.example/')
  }

  resolve(input: string): Promise<BloggerRef> {
    const digits = /\d+/u.exec(input)?.[0]
    if (digits === undefined) return Promise.reject(new Error(`stub source cannot resolve ${input}`))
    return Promise.resolve({
      source: this.id,
      userID: digits,
      ...this.identity.name === undefined ? {} : { userName: this.identity.name },
      ...this.identity.withProfileUrl === true ? { profileUrl: `https://stub.example/${digits}` } : {},
    })
  }

  listPosts(_ref: BloggerRef, request: BloggerListRequest): Promise<BloggerPage<BloggerPostSummary>> {
    this.calls.push(`posts:${request.pageNo}`)
    return Promise.resolve({ items: [...this.posts], pageNo: request.pageNo, pagesFetched: 1, hasMore: this.hasMore })
  }

  fetchPost(_ref: BloggerRef, postId: string): Promise<BloggerPost> {
    this.calls.push(`post:${postId}`)
    const summary = this.posts.find(post => post.id === postId)
    return summary === undefined
      ? Promise.reject(new Error(`stub source has no post ${postId}`))
      : Promise.resolve({ ...summary, bodyMarkdown: `body of ${postId}` })
  }

  listReplies(_ref: BloggerRef, request: BloggerListRequest): Promise<BloggerPage<BloggerReply>> {
    this.calls.push(`replies:${request.pageNo}`)
    return Promise.resolve({ items: [...this.replies], pageNo: request.pageNo, pagesFetched: 1, hasMore: this.hasMore })
  }
}

/** Two posts and two replies, newest first. */
export const STUB_POSTS: BloggerPostSummary[] = [
  { id: 'codeA', url: 'https://stub.example/a/codeA', title: 'First call', publishedAt: '2026-01-02', replies: 3, views: 10 },
  { id: 'codeB', url: 'https://stub.example/a/codeB', title: 'Second call', publishedAt: '2026-01-01', replies: 1, views: 5 },
]

export const STUB_REPLIES: BloggerReply[] = [
  {
    id: 'codeA/1',
    url: 'https://stub.example/a/codeA/1',
    topicTitle: 'Someone else',
    topicUrl: 'https://stub.example/a/other',
    repliedAt: '2026-01-03 09:00',
    body: 'I would wait for volume',
    likes: 2,
  },
  {
    id: 'codeB/2',
    url: 'https://stub.example/a/codeB/2',
    topicTitle: 'Another',
    topicUrl: 'https://stub.example/a/other2',
    repliedAt: '2026-01-02 09:00',
    body: 'Cut it when the thesis breaks',
  },
]

/** One distillation answer in the response grammar: a JSON header, then two marked sections. */
export function profileAnswer(overrides: {
  name?: unknown
  description?: unknown
  skill?: string
  portrait?: string
} = {}): string {
  const { skill, portrait, ...header } = overrides
  return [
    JSON.stringify({
      name: 'stub-blogger-buy-the-dip',
      description: 'Consult when judging a stub blogger\'s dip-buying rules.',
      ...header,
    }),
    PROCEDURE_MARKER,
    skill ?? '## When this applies\n\n- In a falling market with volume.\n\n## Rules\n\n- Wait for volume before buying.',
    EVIDENCE_MARKER,
    portrait ?? '## Worldview\n\n- The blogger buys dips on volume.',
  ].join('\n')
}

/** One temp directory removed by the caller. */
export interface TempRoot {
  /** The absolute directory. */
  readonly path: string
  /** Remove the directory and everything under it. */
  remove(): void
}

/**
 * Create one temp directory for a test.
 *
 * @param prefix - a name prefix for the directory.
 * @returns the directory and its removal handle.
 */
export function tempRoot(prefix: string): TempRoot {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`))
  return { path, remove: () => { rmSync(path, { recursive: true, force: true }) } }
}
