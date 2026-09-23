/**
 * Distillation policy: the corpus digest and its bound, the profile grammar, the
 * rendered skill file, route resolution, and the auxiliary LLM call's recording
 * and failure handling.
 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DISTILL_SYSTEM_PROMPT,
  distillProfile,
  parseProfile,
  renderDigest,
  renderSkillFile,
  resolveRoute,
  writeSkillFile,
} from '../src/profile.ts'
import type { BloggerDistillRequestEventData, DistillSession } from '../src/profile.ts'
import type { BloggerCorpus } from '../src/types.ts'
import { profileAnswer, ScriptedAdapter, tempRoot, textResponse } from './helpers.ts'

const testSignal = new AbortController().signal

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

/** Mount a real LLM runtime over one scripted answer. */
async function mountLlm(script: StreamChunk[]): Promise<{ ctx: Context; adapter: ScriptedAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['stub-provider'], adapter)
  return { ctx, adapter }
}

/** A structural session stub recording what the distillation appended. */
function stubSession(route?: { provider: string; model: string }): {
  session: DistillSession
  appended: BloggerDistillRequestEventData[]
} {
  const appended: BloggerDistillRequestEventData[] = []
  return {
    appended,
    session: {
      id: SessionId('session-1'),
      append: (_type, data) => void appended.push(data),
      requestHeader: () => route === undefined ? undefined : { config: route },
    },
  }
}

describe('renderDigest', () => {
  it('renders the header, every post, and every reply', () => {
    const { digest, truncated } = renderDigest(CORPUS, 100_000)
    expect(truncated).toBe(false)
    expect(digest).toContain('# 博主 Stub Blogger（stub）')
    expect(digest).toContain('主页：https://stub.example/905478')
    expect(digest).toContain('主贴 2 篇（其中 1 篇有正文），跟帖 1 条')
    expect(digest).toContain('## 2026-01-02 《First call》')
    expect(digest).toContain('I bought the dip on volume.')
    expect(digest).toContain('(未采集正文)')
    expect(digest).toContain('- 2026-01-03 09:00 I would wait for volume — 来自《Someone else》')
  })

  it('falls back to the user id when no display name is stored', () => {
    const { source, userID, updatedAt, posts, replies } = CORPUS
    expect(renderDigest({ source, userID, updatedAt, posts, replies }, 100_000).digest).toContain('# 博主 905478（stub）')
  })

  it('stops at the bound and reports the cut', () => {
    const { digest, truncated } = renderDigest(CORPUS, 40)
    expect(truncated).toBe(true)
    expect(digest.length).toBeLessThanOrEqual(40)
    expect(digest).not.toContain('Second call')
  })
})

describe('resolveRoute', () => {
  it('prefers the configured pair', () => {
    const { session } = stubSession({ provider: 'inherited', model: 'inherited-model' })
    expect(resolveRoute({ provider: 'configured', model: 'configured-model' }, session))
      .toEqual({ provider: 'configured', model: 'configured-model' })
  })

  it('inherits the session request target when nothing is configured', () => {
    const { session } = stubSession({ provider: 'inherited', model: 'inherited-model' })
    expect(resolveRoute({}, session)).toEqual({ provider: 'inherited', model: 'inherited-model' })
  })

  it('fails BLOGGER_DISTILL_ROUTE_UNSET when neither source names a route', () => {
    expect(() => resolveRoute({}, undefined))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_DISTILL_ROUTE_UNSET' }))
  })
})

describe('parseProfile', () => {
  it('parses a plain JSON answer', () => {
    expect(parseProfile(profileAnswer())).toEqual({
      name: 'stub-blogger-buy-the-dip',
      description: 'Consult when judging a stub blogger\'s dip-buying rules.',
      content: '## Rules\n\n- Wait for volume before buying.',
    })
  })

  it('parses an answer wrapped in prose and a code fence', () => {
    expect(parseProfile(`Here it is:\n\`\`\`json\n${profileAnswer()}\n\`\`\`\n`).name).toBe('stub-blogger-buy-the-dip')
  })

  it.each([
    ['no JSON object at all', 'I cannot answer that.', /carried no JSON object/],
    ['a truncated object', '{"name":"x"', /carried no JSON object/],
    ['invalid JSON', '{not json}', /did not parse/],
    ['a non-kebab-case name', profileAnswer({ name: 'Stub Blogger' }), /kebab-case skill name/],
    ['a missing name', profileAnswer({ name: 5 }), /kebab-case skill name/],
    ['an empty description', profileAnswer({ description: '   ' }), /no "description" string/],
    ['a non-string description', profileAnswer({ description: 5 }), /no "description" string/],
    ['an empty content', profileAnswer({ content: '  ' }), /no "content" string/],
    ['a non-string content', profileAnswer({ content: 5 }), /no "content" string/],
  ])('rejects %s', (_label, answer, expected) => {
    expect(() => parseProfile(answer))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_PROFILE_INVALID', message: expect.stringMatching(expected) as string }))
  })
})

describe('renderSkillFile', () => {
  it('writes frontmatter whose description survives YAML quoting', () => {
    const file = renderSkillFile({
      name: 'stub-blogger',
      description: 'Use when asking: what would the stub blogger do?',
      content: '# Profile',
    })
    expect(file).toBe([
      '---',
      'name: stub-blogger',
      'description: "Use when asking: what would the stub blogger do?"',
      '---',
      '',
      '# Profile',
      '',
    ].join('\n'))
  })
})

describe('distillProfile', () => {
  it('records the exact request before dispatch and returns the parsed profile', async () => {
    const { ctx, adapter } = await mountLlm(textResponse(profileAnswer()))
    const { session, appended } = stubSession()

    const outcome = await distillProfile(ctx, { maxPromptChars: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, session, signal: testSignal,
    })

    expect(outcome.profile.name).toBe('stub-blogger-buy-the-dip')
    expect(outcome.digestTruncated).toBe(false)
    expect(outcome.digestChars).toBeGreaterThan(0)
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      source: 'stub',
      userID: '905478',
      route: { provider: 'stub-provider', model: 'stub-model' },
      system: DISTILL_SYSTEM_PROMPT,
      maxTokens: 4_000,
    })
    expect(adapter.requests[0]).toMatchObject({ provider: 'stub-provider', model: 'stub-model', system: DISTILL_SYSTEM_PROMPT })
  })

  it('ignores model blocks that carry no visible text', async () => {
    const answer = profileAnswer()
    const { ctx } = await mountLlm([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'weighing the corpus' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing the corpus' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: answer },
      { type: 'block-end', index: 1, block: { type: 'text', text: answer } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const outcome = await distillProfile(ctx, { maxPromptChars: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, signal: testSignal,
    })

    expect(outcome.profile.name).toBe('stub-blogger-buy-the-dip')
  })

  it('dispatches without a session and reports a cut digest', async () => {
    const { ctx, adapter } = await mountLlm(textResponse(profileAnswer()))
    const outcome = await distillProfile(ctx, { maxPromptChars: 30, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, signal: testSignal,
    })

    expect(outcome.digestTruncated).toBe(true)
    expect(adapter.requests[0]?.sessionId).toBeUndefined()
  })

  it.each([
    ['a max-tokens cut', { type: 'finish', reason: { kind: 'max-tokens' } }, /reached maxOutputTokens/],
    ['a tool request', { type: 'finish', reason: { kind: 'tool-calls' } }, /requested a tool/],
    ['an unsupported reason', { type: 'finish', reason: { kind: 'invented' } }, /unsupported finish reason/],
  ])('fails the profile grammar on %s', async (_label, chunk, expected) => {
    const { ctx } = await mountLlm([chunk as StreamChunk])
    await expect(distillProfile(ctx, { maxPromptChars: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, signal: testSignal,
    })).rejects.toThrow(expect.objectContaining({ code: 'BLOGGER_PROFILE_INVALID', message: expect.stringMatching(expected) as string }))
  })

  it('surfaces a model failure with the provider code', async () => {
    const { ctx } = await mountLlm([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'STUB_UPSTREAM' } } },
    ])
    await expect(distillProfile(ctx, { maxPromptChars: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, signal: testSignal,
    })).rejects.toThrow(expect.objectContaining({ code: 'STUB_UPSTREAM', message: expect.stringContaining('upstream exploded') as string }))
  })
})

describe('writeSkillFile', () => {
  it('writes SKILL.md under the name directory and returns its path', async () => {
    const root = tempRoot('blogger-skill')
    try {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem)
      const path = await writeSkillFile(ctx, root.path, {
        name: 'stub-blogger',
        description: 'A stub.',
        content: '# Profile',
      }, testSignal)

      expect(path).toBe(join(root.path, 'stub-blogger', 'SKILL.md'))
      await expect(ctx.fs.readText(await ctx.fs.resolve(path))).resolves.toContain('name: stub-blogger')
    } finally {
      root.remove()
    }
  })
})
