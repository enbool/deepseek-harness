/**
 * The corpus record grammar and the merge that folds one harvest into the
 * stored record, exercised over valid, partial, and malformed records.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BloggerReply } from '@deepseek-ai/dsh-blogger'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { BloggerCorpusStore, corpusPath, mergeDocuments, mergePosts, mergeReplies, parseCorpus, serializeCorpus } from '../src/corpus.ts'
import type { BloggerCorpus, CorpusPost } from '../src/types.ts'
import type { TempRoot } from './helpers.ts'
import { tempRoot } from './helpers.ts'

const testSignal = new AbortController().signal

const PATH = 'corpus.json'

const POST: CorpusPost = {
  id: 'codeA',
  url: 'https://stub.example/a/codeA',
  title: 'First call',
  publishedAt: '2026-01-02',
  bodyMarkdown: 'body',
  replies: 1,
  views: 2,
  likes: 3,
}

const REPLY: BloggerReply = {
  id: 'codeA/1',
  url: 'https://stub.example/a/codeA/1',
  topicTitle: 'Someone else',
  topicUrl: 'https://stub.example/a/other',
  repliedAt: '2026-01-03 09:00',
  body: 'wait for volume',
  likes: 2,
}

const CORPUS: BloggerCorpus = {
  source: 'stub',
  userID: '905478',
  userName: 'Stub Blogger',
  profileUrl: 'https://stub.example/905478',
  updatedAt: '2026-01-01T00:00:00.000Z',
  posts: [POST],
  replies: [REPLY],
}

/** Serialize a mutated copy of the valid corpus. */
function raw(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...CORPUS, ...overrides })
}

describe('corpus grammar', () => {
  it('round-trips a complete corpus', () => {
    expect(parseCorpus(serializeCorpus(CORPUS), PATH)).toEqual(CORPUS)
  })

  it('parses a corpus that omits every optional field', () => {
    const minimal = { source: 'stub', userID: '1', updatedAt: 'now', posts: [], replies: [] }
    expect(parseCorpus(JSON.stringify(minimal), PATH)).toEqual(minimal)
  })

  it('parses a record whose optional counters and body are absent', () => {
    const sparse = {
      source: 'stub',
      userID: '1',
      updatedAt: 'now',
      posts: [{ id: 'a', url: 'u', title: 't', publishedAt: 'd' }],
      replies: [{ id: 'r', url: 'u', topicTitle: 't', topicUrl: 'tu', repliedAt: 'd', body: 'b' }],
    }
    expect(parseCorpus(JSON.stringify(sparse), PATH)).toEqual(sparse)
  })

  it('round-trips the offline origin and the document path', () => {
    const offline = {
      ...CORPUS,
      posts: [{ ...POST, origin: 'offline', documentPath: '/saved/post.txt' }],
      replies: [{ ...REPLY, origin: 'offline', documentPath: '/saved/reply.txt' }],
    }
    expect(parseCorpus(JSON.stringify(offline), PATH)).toEqual(offline)
  })

  it('round-trips a record whose origin is platform', () => {
    const platform = {
      ...CORPUS,
      posts: [{ ...POST, origin: 'platform' }],
      replies: [{ ...REPLY, origin: 'platform' }],
    }
    expect(parseCorpus(JSON.stringify(platform), PATH)).toEqual(platform)
  })

  it('reads a record that carries no origin as a platform record', () => {
    const parsed = parseCorpus(raw({ posts: [{ ...POST }], replies: [{ ...REPLY }] }), PATH)
    expect(parsed.posts[0]).not.toHaveProperty('origin')
    expect(parsed.replies[0]).not.toHaveProperty('origin')
  })

  it('rejects text that is not JSON', () => {
    expect(() => parseCorpus('not json', PATH))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_CORPUS_INVALID', message: expect.stringContaining('not valid JSON') as string }))
  })

  it.each([
    ['an array', '[]', /is not a JSON object/],
    ['a missing source', raw({ source: '' }), /no "source" string/],
    ['a missing user id', raw({ userID: '' }), /no "userID" string/],
    ['a missing timestamp', raw({ updatedAt: '' }), /no "updatedAt" string/],
    ['a non-string user name', raw({ userName: 5 }), /field "userName" is not a string/],
    ['a non-string profile url', raw({ profileUrl: 5 }), /field "profileUrl" is not a string/],
    ['a missing posts array', raw({ posts: undefined }), /no "posts" array/],
    ['a missing replies array', raw({ replies: undefined }), /no "replies" array/],
    ['a non-object post', raw({ posts: ['x'] }), /posts\[0\] is not a JSON object/],
    ['a post without an id', raw({ posts: [{ url: 'u', title: 't', publishedAt: 'd' }] }), /posts\[0\] has no "id" string/],
    ['a non-string post body', raw({ posts: [{ ...POST, bodyMarkdown: 5 }] }), /field "bodyMarkdown" is not a string/],
    ['a non-string post document path', raw({ posts: [{ ...POST, documentPath: 5 }] }), /field "documentPath" is not a string/],
    ['a post origin that is neither platform nor offline', raw({ posts: [{ ...POST, origin: 'archive' }] }), /field "origin" is not "platform" or "offline"/],
    ['a non-numeric post counter', raw({ posts: [{ ...POST, replies: 'x' }] }), /field "replies" is not a number/],
    ['a non-object reply', raw({ replies: ['x'] }), /replies\[0\] is not a JSON object/],
    ['a reply without a body', raw({ replies: [{ ...REPLY, body: '' }] }), /replies\[0\] has no "body" string/],
    ['a non-string reply document path', raw({ replies: [{ ...REPLY, documentPath: 5 }] }), /field "documentPath" is not a string/],
    ['a reply origin that is neither platform nor offline', raw({ replies: [{ ...REPLY, origin: 'archive' }] }), /field "origin" is not "platform" or "offline"/],
    ['a non-numeric reply counter', raw({ replies: [{ ...REPLY, likes: 'x' }] }), /field "likes" is not a number/],
  ])('rejects %s', (_label, text, expected) => {
    expect(() => parseCorpus(text, PATH))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_CORPUS_INVALID', message: expect.stringMatching(expected) as string }))
  })

  it('builds a per-source, per-user corpus path', () => {
    expect(corpusPath('/root', 'stub', '905478')).toBe(join('/root', 'stub-905478.json'))
  })
})

describe('corpus merge', () => {
  const bare = (id: string, publishedAt: string): CorpusPost => ({
    id, url: `u/${id}`, title: id, publishedAt,
  })

  it('keeps a stored body when the fresh listing carries none', () => {
    const merged = mergePosts([POST], [bare('codeA', '2026-01-02')], 10, 'start')
    expect(merged).toEqual([{ ...bare('codeA', '2026-01-02'), bodyMarkdown: 'body' }])
  })

  it('prefers a freshly fetched body and appends posts the listing no longer carries', () => {
    const merged = mergePosts([bare('gone', '2025-01-01'), POST], [{ ...bare('codeA', '2026-01-02'), bodyMarkdown: 'new' }], 10, 'start')
    expect(merged).toEqual([
      { ...bare('codeA', '2026-01-02'), bodyMarkdown: 'new' },
      bare('gone', '2025-01-01'),
    ])
  })

  it('caps the retained posts at the newest end', () => {
    expect(mergePosts([bare('a', 'd'), bare('b', 'd')], [bare('c', 'd')], 2, 'start').map(post => post.id)).toEqual(['c', 'a'])
  })

  it('places a window that continues past the stored posts after them', () => {
    const merged = mergePosts([POST, bare('codeB', '2026-01-01')], [bare('codeC', '2025-12-31')], 10, 'end')
    expect(merged.map(post => post.id)).toEqual(['codeA', 'codeB', 'codeC'])
  })

  it('refreshes a stored post in place when a continuing window sees it again', () => {
    const merged = mergePosts([POST], [{ ...bare('codeA', '2026-01-02'), bodyMarkdown: 'new' }], 10, 'end')
    expect(merged).toEqual([{ ...bare('codeA', '2026-01-02'), bodyMarkdown: 'new' }])
  })

  it('keeps a stored body when a continuing window lists the post without one', () => {
    const merged = mergePosts([POST], [bare('codeA', '2026-01-02')], 10, 'end')
    expect(merged).toEqual([{ ...bare('codeA', '2026-01-02'), bodyMarkdown: 'body' }])
  })

  it('caps a continuing post window at the newest end too', () => {
    expect(mergePosts([bare('a', 'd'), bare('b', 'd')], [bare('c', 'd')], 2, 'end').map(post => post.id)).toEqual(['a', 'b'])
  })

  it('deduplicates replies and appends the ones the fresh listing dropped', () => {
    const older: BloggerReply = { ...REPLY, id: 'codeB/9', body: 'older' }
    expect(mergeReplies([older, REPLY], [REPLY], 10, 'start')).toEqual([REPLY, older])
  })

  it('caps the retained replies at the newest end', () => {
    const another: BloggerReply = { ...REPLY, id: 'codeB/9' }
    expect(mergeReplies([REPLY, another], [], 1, 'start')).toEqual([REPLY])
  })

  it('places a window that continues past the stored replies after them', () => {
    const older: BloggerReply = { ...REPLY, id: 'codeB/9' }
    expect(mergeReplies([older], [REPLY], 10, 'end')).toEqual([older, REPLY])
  })

  it('refreshes a stored reply in place when a continuing window sees it again', () => {
    const stale: BloggerReply = { ...REPLY, body: 'stale' }
    expect(mergeReplies([stale], [REPLY], 10, 'end')).toEqual([REPLY])
  })

  it('caps a continuing reply window at the newest end too', () => {
    const older: BloggerReply = { ...REPLY, id: 'codeB/9' }
    const olderStill: BloggerReply = { ...REPLY, id: 'codeC/8' }
    expect(mergeReplies([older, olderStill], [REPLY], 2, 'end').map(reply => reply.id)).toEqual(['codeB/9', 'codeC/8'])
  })

  it('retains an offline post the platform bound would otherwise drop', () => {
    const saved: CorpusPost = { ...bare('saved', '2025-01-01'), origin: 'offline', documentPath: '/saved/saved.md' }
    const merged = mergePosts([bare('a', 'd'), bare('b', 'd')], [saved], 1, 'start')

    expect(merged.map(post => post.id)).toEqual(['saved', 'a'])
  })

  it('retains an offline reply the platform bound would otherwise drop', () => {
    const saved = { ...REPLY, id: 'saved', origin: 'offline' as const, documentPath: '/saved/saved.md' }
    const merged = mergeReplies([REPLY, { ...REPLY, id: 'codeB/9' }], [saved], 1, 'start')

    expect(merged.map(reply => reply.id)).toEqual(['saved', 'codeA/1'])
  })
})

describe('mergeDocuments', () => {
  const offline = (id: string, publishedAt: string): CorpusPost => ({
    id, url: `u/${id}`, title: id, publishedAt, origin: 'offline', documentPath: `/saved/${id}.md`,
  })

  it('replaces a stored record under the same id instead of duplicating it', () => {
    const merged = mergeDocuments(
      [offline('offline:/saved/a.md', '2026-01-05')],
      [{ ...offline('offline:/saved/a.md', '2026-01-05'), title: 'rewritten' }],
      entry => entry.publishedAt,
    )

    expect(merged).toEqual([{ ...offline('offline:/saved/a.md', '2026-01-05'), title: 'rewritten' }])
  })

  it('places a dated record at its date, after an equally dated one and before an older one', () => {
    const stored = [offline('new', '2026-01-09'), offline('same', '2026-01-05'), offline('old', '2026-01-01')]
    const merged = mergeDocuments(stored, [offline('mid', '2026-01-05')], entry => entry.publishedAt)

    expect(merged.map(entry => entry.id)).toEqual(['new', 'same', 'mid', 'old'])
  })

  it('places a dated record ahead of a dateless one and a dateless record after every dated one', () => {
    expect(mergeDocuments([offline('none', '日期不详')], [offline('dated', '2026-01-01')], entry => entry.publishedAt)
      .map(entry => entry.id)).toEqual(['dated', 'none'])

    expect(mergeDocuments([offline('new', '2026-01-09'), offline('old', '2026-01-01')], [offline('none', '日期不详')], entry => entry.publishedAt)
      .map(entry => entry.id)).toEqual(['new', 'old', 'none'])
  })

  it('keeps every stored record when the intake is empty', () => {
    const stored = [offline('a', '2026-01-01')]
    expect(mergeDocuments(stored, [], entry => entry.publishedAt)).toEqual(stored)
  })
})

describe('BloggerCorpusStore.ingest', () => {
  /** Mount a real filesystem and one store over a temp corpus root. */
  async function mountStore(): Promise<{ store: BloggerCorpusStore; root: TempRoot }> {
    const root = tempRoot('blogger-corpus')
    const ctx = new Context()
    await ctx.plugin(LocalFileSystem)
    return {
      store: new BloggerCorpusStore(ctx, root.path, { maxCorpusPosts: 2, maxCorpusReplies: 1 }),
      root,
    }
  }

  const DOC_A: CorpusPost = {
    id: 'offline:/saved/a.md',
    url: '/saved/a.md',
    title: 'A',
    publishedAt: '2026-01-02',
    bodyMarkdown: 'body of A',
    origin: 'offline',
    documentPath: '/saved/a.md',
  }

  it('writes a first document intake, then replaces the record the same path names again', async () => {
    const { store, root } = await mountStore()
    try {
      const intake = {
        source: 'local',
        userID: '炒股养家',
        userName: '炒股养家',
        updatedAt: '2026-01-03T00:00:00.000Z',
        posts: [DOC_A],
        replies: [],
      }
      const first = await store.ingest(undefined, intake, testSignal)

      expect(first).toMatchObject({ source: 'local', userID: '炒股养家', userName: '炒股养家' })
      expect((await store.read('local', '炒股养家', testSignal))?.posts).toEqual([DOC_A])

      const second = await store.ingest(first, {
        ...intake,
        posts: [{ ...DOC_A, title: 'A rewritten', bodyMarkdown: 'rewritten' }],
      }, testSignal)

      expect(second.posts).toEqual([{ ...DOC_A, title: 'A rewritten', bodyMarkdown: 'rewritten' }])
      expect((await store.read('local', '炒股养家', testSignal))?.posts).toHaveLength(1)
    } finally {
      root.remove()
    }
  })

  it('keeps the stored display name and profile url when the intake learns neither', async () => {
    const { store, root } = await mountStore()
    try {
      const stored = await store.merge(undefined, {
        source: 'stub',
        userID: '905478',
        userName: 'Stub Blogger',
        profileUrl: 'https://stub.example/905478',
        updatedAt: '2026-01-01T00:00:00.000Z',
        postStartPage: 1,
        replyStartPage: 1,
        posts: [],
        replies: [],
      }, testSignal)

      const ingested = await store.ingest(stored, {
        source: 'stub',
        userID: '905478',
        updatedAt: '2026-01-04T00:00:00.000Z',
        posts: [DOC_A],
        replies: [],
      }, testSignal)

      expect(ingested).toMatchObject({ userName: 'Stub Blogger', profileUrl: 'https://stub.example/905478' })
    } finally {
      root.remove()
    }
  })

  it('orders an ingested document by its date and leaves a dateless one last', async () => {
    const { store, root } = await mountStore()
    try {
      const stored = await store.merge(undefined, {
        source: 'stub',
        userID: '905478',
        updatedAt: '2026-01-01T00:00:00.000Z',
        postStartPage: 1,
        replyStartPage: 1,
        posts: [
          { id: 'new', url: 'u/new', title: 'new', publishedAt: '2026-01-09', origin: 'platform' },
          { id: 'old', url: 'u/old', title: 'old', publishedAt: '2026-01-01', origin: 'platform' },
        ],
        replies: [{ ...REPLY, id: 'platform/1', repliedAt: '2025-01-01', origin: 'platform' }],
      }, testSignal)

      const ingested = await store.ingest(stored, {
        source: 'stub',
        userID: '905478',
        updatedAt: '2026-01-10T00:00:00.000Z',
        posts: [
          { ...DOC_A, id: 'mid', publishedAt: '2026-01-05' },
          { ...DOC_A, id: 'none', publishedAt: '日期不详' },
        ],
        replies: [{ ...REPLY, origin: 'offline', documentPath: '/saved/r.md' }],
      }, testSignal)

      expect(ingested.posts.map(post => post.id)).toEqual(['new', 'mid', 'old', 'none'])
      expect(ingested.replies.map(reply => reply.id)).toEqual(['codeA/1', 'platform/1'])
      expect((await store.read('stub', '905478', testSignal))?.posts.map(post => post.id))
        .toEqual(['new', 'mid', 'old', 'none'])
    } finally {
      root.remove()
    }
  })
})
