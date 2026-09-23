/**
 * Corpus chunking: the token estimate, the ordered digest blocks, and the
 * grouping that keeps every distillation request within its budget.
 */

import { describe, expect, it } from 'vitest'
import { chunkBlocks, digestBlocks, estimateTokens } from '../src/chunk.ts'
import type { BloggerCorpus } from '../src/types.ts'

const CORPUS: BloggerCorpus = {
  source: 'stub',
  userID: '905478',
  userName: 'Stub Blogger',
  profileUrl: 'https://stub.example/905478',
  updatedAt: '2026-01-01T00:00:00.000Z',
  posts: [
    {
      id: 'codeA',
      url: 'https://stub.example/a/codeA',
      title: 'First call',
      publishedAt: '2026-01-02',
      bodyMarkdown: 'I bought the dip on volume.',
    },
    {
      id: 'codeB',
      url: 'https://stub.example/a/codeB',
      title: 'Second call',
      publishedAt: '2026-01-01',
    },
  ],
  replies: [
    {
      id: 'other/1',
      url: 'https://stub.example/a/other/1',
      topicTitle: 'Someone else',
      topicUrl: 'https://stub.example/a/other',
      repliedAt: '2026-01-03 09:00',
      body: 'I would wait for volume',
    },
  ],
}

/** Thousands of CJK characters, for the budget cases. */
const LONG = '追涨杀跌'.repeat(50)

describe('estimateTokens', () => {
  it('counts CJK characters as one token each', () => {
    expect(estimateTokens('追涨杀跌')).toBe(4)
    expect(estimateTokens('追涨杀跌')).toBe('追涨杀跌'.length)
  })

  it('counts other text at a third of a token per character and rounds up', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('digestBlocks', () => {
  it('renders the header first, then every post, then every reply', () => {
    const blocks = digestBlocks(CORPUS, 100_000)
    expect(blocks).toHaveLength(4)
    expect(blocks[0]?.text).toContain('# 博主 Stub Blogger（stub）')
    expect(blocks[0]?.text).toContain('主页：https://stub.example/905478')
    expect(blocks[0]?.text).toContain('主贴 2 篇（其中 1 篇有正文），跟帖 1 条')
    expect(blocks[1]?.text).toContain('## 2026-01-02 《First call》')
    expect(blocks[1]?.text).toContain('I bought the dip on volume.')
    expect(blocks[2]?.text).toContain('(未采集正文)')
    expect(blocks[3]?.text).toContain('- 2026-01-03 09:00 I would wait for volume — 来自《Someone else》')
  })

  it('falls back to the user id when no display name is stored', () => {
    const { source, userID, updatedAt, posts, replies } = CORPUS
    expect(digestBlocks({ source, userID, updatedAt, posts, replies }, 100_000)[0]?.text)
      .toContain('# 博主 905478（stub）')
  })

  it('splits a record too large for the budget instead of cutting it', () => {
    const long: BloggerCorpus = {
      ...CORPUS,
      posts: [{ ...CORPUS.posts[0]!, bodyMarkdown: LONG }],
    }
    const blocks = digestBlocks(long, 20)
    // The over-budget post becomes consecutive pieces; the header and reply stay single.
    expect(blocks.length).toBeGreaterThan(4)
    const post = blocks.filter(block => block.tokens <= 20)
    expect(post.length).toBe(blocks.length)
    const joined = blocks.map(block => block.text).join('')
    expect(joined).toContain(LONG.slice(0, 40))
    expect(joined).toContain(LONG.slice(-40))
    expect(LONG.startsWith(joined.split('## ')[2] ?? '')).toBe(true)
  })

  it('hard-slices a single paragraph larger than the whole budget', () => {
    const long: BloggerCorpus = {
      ...CORPUS,
      posts: [{ ...CORPUS.posts[0]!, bodyMarkdown: LONG }],
    }
    const blocks = digestBlocks(long, 20)

    expect(blocks.every(block => block.tokens <= 20)).toBe(true)
    expect(blocks.filter(block => block.text.startsWith('## 2026-01-02'))).toHaveLength(1)
    expect(blocks.map(block => block.text).join('')).toContain(LONG)
  })

  it('joins several under-budget paragraphs into one block before starting the next', () => {
    const paragraph = '追涨杀跌'.repeat(5)
    const body = [paragraph, paragraph, paragraph].join('\n\n')
    const grouped: BloggerCorpus = {
      ...CORPUS,
      posts: [{ ...CORPUS.posts[0]!, bodyMarkdown: body }],
    }

    const blocks = digestBlocks(grouped, 60)

    expect(blocks.map(block => block.text.split(paragraph).length - 1)).toContain(2)
    expect(blocks.every(block => block.tokens <= 60)).toBe(true)
  })

  it('reports the offline records in the header', () => {
    const offline: BloggerCorpus = {
      ...CORPUS,
      posts: [{ ...CORPUS.posts[0]!, origin: 'offline', documentPath: '/saved/a.txt' }],
      replies: [{ ...CORPUS.replies[0]!, origin: 'offline', documentPath: '/saved/r.txt' }],
    }

    expect(digestBlocks(offline, 100_000)[0]?.text).toContain('其中 2 条来自离线文档，平台上已不可见。')
  })
})

describe('chunkBlocks', () => {
  const blocks = [
    { text: 'aaa', tokens: 10 },
    { text: 'bbb', tokens: 10 },
    { text: 'ccc', tokens: 10 },
  ]

  it('keeps every block in one chunk while the budget allows', () => {
    expect(chunkBlocks(blocks, 100)).toEqual([{ index: 1, text: 'aaa\nbbb\nccc', tokens: 31 }])
  })

  it('starts a new chunk before the budget is exceeded, preserving order', () => {
    const chunks = chunkBlocks(blocks, 21)
    expect(chunks.map(chunk => chunk.text)).toEqual(['aaa\nbbb', 'ccc'])
    expect(chunks.map(chunk => chunk.index)).toEqual([1, 2])
  })

  it('gives an over-budget block a chunk of its own rather than splitting it', () => {
    const chunks = chunkBlocks([{ text: 'huge', tokens: 500 }, blocks[0]!], 20)
    expect(chunks.map(chunk => chunk.text)).toEqual(['huge', 'aaa'])
  })

  it('returns no chunks for no blocks', () => {
    expect(chunkBlocks([], 100)).toEqual([])
  })

  it('groups the whole corpus for a budget that fits it', () => {
    const chunks = chunkBlocks(digestBlocks(CORPUS, 100_000), 100_000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.index).toBe(1)
  })
})
