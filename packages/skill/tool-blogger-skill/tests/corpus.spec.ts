/**
 * The corpus record grammar and the merge that folds one harvest into the
 * stored record, exercised over valid, partial, and malformed records.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BloggerReply } from '@deepseek-ai/dsh-blogger'
import { corpusPath, mergePosts, mergeReplies, parseCorpus, serializeCorpus } from '../src/corpus.ts'
import type { BloggerCorpus, CorpusPost } from '../src/types.ts'

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
    ['a non-numeric post counter', raw({ posts: [{ ...POST, replies: 'x' }] }), /field "replies" is not a number/],
    ['a non-object reply', raw({ replies: ['x'] }), /replies\[0\] is not a JSON object/],
    ['a reply without a body', raw({ replies: [{ ...REPLY, body: '' }] }), /replies\[0\] has no "body" string/],
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
})
