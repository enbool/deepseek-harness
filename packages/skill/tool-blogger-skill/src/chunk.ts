/**
 * Bounded corpus chunking for distillation. One request cannot carry a whole
 * corpus: CJK text costs roughly one token per character, so a quarter-million
 * character digest is already past a 128k-token window. This module renders the
 * corpus as ordered blocks and groups them into chunks that each fit a token
 * budget, so every model request stays bounded however large the corpus grows.
 * @module @deepseek-ai/dsh-tool-blogger-skill/chunk
 */

import type { BloggerCorpus } from './types.ts'

/** One rendered piece of the corpus: the header, one post, or one reply. */
export interface DigestBlock {
  /** The rendered markdown. */
  readonly text: string
  /** Estimated tokens this block costs. */
  readonly tokens: number
}

/** One bounded group of digest blocks: the unit of one model request. */
export interface DigestChunk {
  /** 1-based position in the corpus, in list order. */
  readonly index: number
  /** The chunk's markdown. */
  readonly text: string
  /** Estimated tokens this chunk costs. */
  readonly tokens: number
}

/** Cost of the newline joining two blocks, so the estimate matches the joined text. */
const JOIN_TOKENS = 0.3

/**
 * Estimate the tokens one string costs. CJK characters count as one token each
 * and everything else as a third, which is close enough to bound a request: the
 * estimate is conservative for Latin text and accurate for the Chinese prose
 * these tools mostly carry.
 *
 * @param text - the text to measure.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const character of text) {
    tokens += isCjk(character.charCodeAt(0)) ? 1 : 0.3
  }
  return Math.ceil(tokens)
}

/**
 * Render one corpus as ordered digest blocks: the header first, then the posts
 * and the replies in corpus list order. A record longer than the budget becomes
 * several consecutive blocks rather than a truncated one, so a document far
 * larger than a single request is still read in full.
 *
 * @param corpus - the corpus to render.
 * @param maxBlockTokens - the token budget one block may cost.
 * @returns the rendered blocks in corpus order.
 */
export function digestBlocks(corpus: BloggerCorpus, maxBlockTokens: number): DigestBlock[] {
  const withBody = corpus.posts.filter(post => post.bodyMarkdown !== undefined).length
  const offline = corpus.posts.filter(post => post.origin === 'offline').length
    + corpus.replies.filter(reply => reply.origin === 'offline').length
  const rendered = [
    [
      `# 博主 ${corpus.userName ?? corpus.userID}（${corpus.source}）`,
      ...corpus.profileUrl === undefined ? [] : [`主页：${corpus.profileUrl}`],
      `采集范围：主贴 ${corpus.posts.length} 篇（其中 ${withBody} 篇有正文），跟帖 ${corpus.replies.length} 条。`,
      ...offline === 0 ? [] : [`其中 ${offline} 条来自离线文档，平台上已不可见。`],
    ].join('\n'),
    ...corpus.posts.map(post => [
      `## ${post.publishedAt} 《${post.title}》`,
      post.url,
      post.bodyMarkdown ?? '(未采集正文)',
    ].join('\n')),
    ...corpus.replies.map(reply =>
      `- ${reply.repliedAt} ${reply.body} — 来自《${reply.topicTitle}》 ${reply.topicUrl}`),
  ]
  return rendered.flatMap(text => splitBlock(text, maxBlockTokens))
}

/**
 * Split one over-budget block into consecutive blocks that each fit the budget.
 * Text splits at paragraph boundaries first and hard-slices only a paragraph that
 * alone exceeds a whole request, so nothing is dropped.
 *
 * @param text - the rendered block.
 * @param budget - the token budget one block may cost.
 * @returns the block, or its consecutive pieces in reading order.
 */
function splitBlock(text: string, budget: number): DigestBlock[] {
  const tokens = estimateTokens(text)
  if (tokens <= budget) return [{ text, tokens }]
  const blocks: DigestBlock[] = []
  let parts: string[] = []
  let used = 0
  const flush = (): void => {
    const joined = parts.join('\n\n')
    blocks.push({ text: joined, tokens: estimateTokens(joined) })
    parts = []
    used = 0
  }
  for (const unit of splitParagraphs(text, budget)) {
    const cost = estimateTokens(unit) + (parts.length === 0 ? 0 : JOIN_TOKENS)
    if (parts.length > 0 && used + cost > budget) flush()
    parts.push(unit)
    used += cost
  }
  flush()
  return blocks
}

/**
 * Split text into pieces no larger than the budget, at paragraph boundaries.
 *
 * @param text - the text to split.
 * @param budget - the token budget one piece may cost.
 * @returns the pieces in reading order.
 */
function splitParagraphs(text: string, budget: number): string[] {
  const pieces: string[] = []
  for (const paragraph of text.split(/\n{2,}/u)) {
    if (estimateTokens(paragraph) <= budget) {
      pieces.push(paragraph)
      continue
    }
    let rest = paragraph
    while (rest.length > 0) {
      const slice = sliceToTokens(rest, budget)
      pieces.push(slice)
      rest = rest.slice(slice.length)
    }
  }
  return pieces
}

/**
 * Slice one string to an estimated token budget. A positive budget always yields
 * at least one character, so the returned prefix is never empty.
 *
 * @param text - the text to slice.
 * @param budget - the estimated tokens to keep.
 * @returns the longest prefix within the budget.
 */
function sliceToTokens(text: string, budget: number): string {
  let tokens = 0
  let end = 0
  for (const character of text) {
    tokens += isCjk(character.charCodeAt(0)) ? 1 : 0.3
    if (tokens > budget) break
    end += character.length
  }
  return text.slice(0, end)
}

/**
 * Group ordered blocks into chunks that each fit the token budget. Block order is
 * preserved, and a block never splits across chunks, so every chunk stays a
 * contiguous window of the corpus.
 *
 * @param blocks - the blocks in corpus order.
 * @param maxTokens - the token budget one chunk may cost.
 * @returns the chunks in corpus order; empty when there are no blocks.
 */
export function chunkBlocks(blocks: readonly DigestBlock[], maxTokens: number): DigestChunk[] {
  const chunks: DigestChunk[] = []
  let parts: string[] = []
  let tokens = 0
  const flush = (): void => {
    if (parts.length === 0) return
    chunks.push({ index: chunks.length + 1, text: parts.join('\n'), tokens: Math.ceil(tokens) })
    parts = []
    tokens = 0
  }
  for (const block of blocks) {
    const cost = block.tokens + (parts.length === 0 ? 0 : JOIN_TOKENS)
    if (parts.length > 0 && tokens + cost > maxTokens) flush()
    parts.push(block.text)
    tokens += cost
  }
  flush()
  return chunks
}

/**
 * Whether one UTF-16 code unit belongs to a CJK script, whose tokenizers spend
 * about one token per character. Astral-plane characters arrive here as their
 * surrogate half and therefore count as Latin text, which underestimates a
 * handful of rare ideographs and never overestimates the request.
 *
 * @param code - the UTF-16 code unit.
 * @returns true for CJK text and punctuation.
 */
function isCjk(code: number): boolean {
  return (code >= 0x3000 && code <= 0x303F)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFF00 && code <= 0xFFEF)
}
