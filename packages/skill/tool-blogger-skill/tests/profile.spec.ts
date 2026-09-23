/**
 * Distillation policy: the corpus digest and its bound, the profile grammar, the
 * rendered skill file, route resolution, and the auxiliary LLM call's recording
 * and failure handling.
 */

import { readdirSync, writeFileSync } from 'node:fs'
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
  PORTRAIT_SYSTEM_PROMPT,
  parsePortrait,
  parseProcedure,
  renderSkillFile,
  resolveRoute,
  skillDirectory,
  writeSkillFile,
} from '../src/profile.ts'
import type { BloggerDistillRequestEventData, DistillSession } from '../src/profile.ts'
import type { BloggerCorpus } from '../src/types.ts'
import { profileAnswer, RoutingAdapter, ScriptedAdapter, tempRoot, textResponse } from './helpers.ts'

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

describe('parseProcedure', () => {
  it('parses a plain JSON answer', () => {
    expect(parseProcedure(profileAnswer())).toEqual({
      name: 'stub-blogger-buy-the-dip',
      description: 'Consult when judging a stub blogger\'s dip-buying rules.',
      skill: '## When this applies\n\n- In a falling market with volume.\n\n## Rules\n\n- Wait for volume before buying.',
    })
  })

  it('parses an answer wrapped in prose and a code fence', () => {
    expect(parseProcedure(`Here it is:\n\`\`\`json\n${profileAnswer()}\n\`\`\`\n`).name).toBe('stub-blogger-buy-the-dip')
  })

  it('strips a fence the model wrapped around the procedure anyway', () => {
    expect(parseProcedure(profileAnswer({ skill: '```markdown\n## Rules\n\n- Act.\n```' })).skill)
      .toBe('## Rules\n\n- Act.')
  })

  it.each([
    ['no JSON header at all', 'I cannot answer that.', /did not begin with the JSON header object/],
    ['an unterminated header', '{"name":"x"', /did not begin with the JSON header object/],
    ['an invalid header', '{not json}\n<<<DSH:PROCEDURE>>>\nx', /JSON header did not parse/],
    ['a non-kebab-case name', profileAnswer({ name: 'Stub Blogger' }), /kebab-case skill name/],
    ['a missing name', profileAnswer({ name: 5 }), /kebab-case skill name/],
    ['an empty description', profileAnswer({ description: '   ' }), /header carried no "description" string/],
    ['a non-string description', profileAnswer({ description: 5 }), /header carried no "description" string/],
    ['no procedure marker', '{"name":"stub-blogger","description":"d"}\nno marker here', /carried no <<<DSH:PROCEDURE>>> line/],
    ['an empty procedure', profileAnswer({ skill: '   ' }), /empty operating procedure/],
  ])('rejects %s', (_label, answer, expected) => {
    expect(() => parseProcedure(answer))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_PROFILE_INVALID', message: expect.stringMatching(expected) as string }))
  })

  it('quotes the answer that failed so the model can see what it wrote', () => {
    expect(() => parseProcedure('I cannot answer that.'))
      .toThrow(expect.objectContaining({ message: expect.stringContaining('the answer began: "I cannot answer that."') as string }))
  })
})

describe('parsePortrait', () => {
  it('takes the whole answer as the portrait', () => {
    expect(parsePortrait('# Worldview\n\n- Evidence.')).toBe('# Worldview\n\n- Evidence.')
  })

  it('strips a fence the model wrapped around the portrait anyway', () => {
    expect(parsePortrait('```markdown\n# Worldview\n```')).toBe('# Worldview')
  })

  it('rejects an empty portrait', () => {
    expect(() => parsePortrait('   '))
      .toThrow(expect.objectContaining({ code: 'BLOGGER_PROFILE_INVALID', message: expect.stringContaining('empty evidence portrait') as string }))
  })
})

describe('renderSkillFile', () => {
  it('writes frontmatter whose description survives YAML quoting, and points at the portrait', () => {
    const file = renderSkillFile({
      name: 'stub-blogger',
      description: 'Use when asking: what would the stub blogger do?',
      skill: '# Procedure\n\n- Act.',
      portrait: '# Portrait',
    })
    expect(file).toBe([
      '---',
      'name: stub-blogger',
      'description: "Use when asking: what would the stub blogger do?"',
      '---',
      '',
      '# Procedure',
      '',
      '- Act.',
      '',
      '---',
      '',
      'The investor behind these rules: [`portrait.md`](portrait.md).',
      '',
    ].join('\n'))
  })
})

describe('distillProfile', () => {
  it('records the exact request before dispatch and returns the parsed profile', async () => {
    const { ctx, adapter } = await mountLlm(textResponse(profileAnswer()))
    const { session, appended } = stubSession()

    const outcome = await distillProfile(ctx, { maxPromptTokens: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, session,
      notesRoot: '/notes', signal: testSignal,
    })

    expect(outcome.profile.name).toBe('stub-blogger-buy-the-dip')
    expect(outcome.passes).toBe(2)
    expect(outcome.notesReused).toBe(0)
    expect(outcome.evidenceChars).toBeGreaterThan(0)
    expect(appended).toHaveLength(2)
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
    const outcome = await distillProfile(ctx, { maxPromptTokens: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, notesRoot: '/notes', signal: testSignal,
    })

    expect(outcome.profile.name).toBe('stub-blogger-buy-the-dip')
  })

  it('dispatches without a session', async () => {
    const { ctx, adapter } = await mountLlm(textResponse(profileAnswer()))
    const outcome = await distillProfile(ctx, { maxPromptTokens: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, notesRoot: '/notes', signal: testSignal,
    })

    expect(outcome.passes).toBe(2)
    expect(adapter.requests[0]?.sessionId).toBeUndefined()
  })

  it('reads a corpus beyond the budget window by window, then merges the notes', async () => {
    const root = tempRoot('blogger-notes')
    try {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(LlmRuntime)
      const adapter = new RoutingAdapter()
      ctx.llm.registerAdapter(['stub-provider'], adapter)
      const large: BloggerCorpus = {
        ...CORPUS,
        replies: Array.from({ length: 20 }, (_, index) => ({
          id: `other/${index}`,
          url: `https://stub.example/a/other/${index}`,
          topicTitle: 'Someone else',
          topicUrl: 'https://stub.example/a/other',
          repliedAt: '2026-01-03 09:00',
          body: '追涨杀跌'.repeat(20),
        })),
      }
      const request = {
        corpus: large,
        route: { provider: 'stub-provider', model: 'stub-model' },
        notesRoot: root.path,
        signal: testSignal,
      }

      const first = await distillProfile(ctx, { maxPromptTokens: 400, maxOutputTokens: 4_000 }, request)

      expect(first.notesReused).toBe(0)
      expect(first.passes).toBeGreaterThan(2)
      // Every window note, then the procedure pass and the portrait pass.
      expect(first.passes).toBe(adapter.requests.length)
      expect(adapter.requests.at(-1)?.system).toBe(PORTRAIT_SYSTEM_PROMPT)

      const reused = await distillProfile(ctx, { maxPromptTokens: 400, maxOutputTokens: 4_000 }, request)

      expect(reused.passes).toBe(2)
      expect(reused.notesReused).toBe(first.passes - 2)

      // An empty stored note is not evidence, so that window is read again.
      const notes = readdirSync(join(root.path, 'stub-905478'))
      writeFileSync(join(root.path, 'stub-905478', notes[0]!), '')
      const emptied = await distillProfile(ctx, { maxPromptTokens: 400, maxOutputTokens: 4_000 }, request)

      expect(emptied.notesReused).toBe(first.passes - 3)
      expect(emptied.passes).toBe(3)
    } finally {
      root.remove()
    }
  })

  it('fails loud when the procedure pushes the portrait request past the budget', async () => {
    const root = tempRoot('blogger-notes')
    try {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['stub-provider'], new RoutingAdapter(
        undefined,
        profileAnswer({ skill: '追涨杀跌'.repeat(2000) }),
      ))
      const large: BloggerCorpus = {
        ...CORPUS,
        replies: Array.from({ length: 20 }, (_, index) => ({
          id: `other/${index}`,
          url: `https://stub.example/a/other/${index}`,
          topicTitle: 'Someone else',
          topicUrl: 'https://stub.example/a/other',
          repliedAt: '2026-01-03 09:00',
          body: '追涨杀跌'.repeat(20),
        })),
      }

      await expect(distillProfile(ctx, { maxPromptTokens: 900, maxOutputTokens: 4_000 }, {
        corpus: large,
        route: { provider: 'stub-provider', model: 'stub-model' },
        notesRoot: root.path,
        signal: testSignal,
      })).rejects.toThrow(expect.objectContaining({
        code: 'BLOGGER_EVIDENCE_TOO_LARGE',
        message: expect.stringContaining('portrait budget') as string,
      }))
    } finally {
      root.remove()
    }
  })

  it('fails loud when the merged notes exceed the request budget', async () => {
    const root = tempRoot('blogger-notes')
    try {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['stub-provider'], new RoutingAdapter('追涨杀跌'.repeat(200)))
      const large: BloggerCorpus = {
        ...CORPUS,
        replies: Array.from({ length: 20 }, (_, index) => ({
          id: `other/${index}`,
          url: `https://stub.example/a/other/${index}`,
          topicTitle: 'Someone else',
          topicUrl: 'https://stub.example/a/other',
          repliedAt: '2026-01-03 09:00',
          body: '追涨杀跌'.repeat(20),
        })),
      }

      await expect(distillProfile(ctx, { maxPromptTokens: 400, maxOutputTokens: 4_000 }, {
        corpus: large,
        route: { provider: 'stub-provider', model: 'stub-model' },
        notesRoot: root.path,
        signal: testSignal,
      })).rejects.toThrow(expect.objectContaining({ code: 'BLOGGER_EVIDENCE_TOO_LARGE' }))
    } finally {
      root.remove()
    }
  })

  it.each([
    ['a max-tokens cut', { type: 'finish', reason: { kind: 'max-tokens' } }, /reached maxOutputTokens/],
    ['a tool request', { type: 'finish', reason: { kind: 'tool-calls' } }, /requested a tool/],
    ['an unsupported reason', { type: 'finish', reason: { kind: 'invented' } }, /unsupported finish reason/],
  ])('fails the profile grammar on %s', async (_label, chunk, expected) => {
    const { ctx } = await mountLlm([chunk as StreamChunk])
    await expect(distillProfile(ctx, { maxPromptTokens: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, notesRoot: '/notes', signal: testSignal,
    })).rejects.toThrow(expect.objectContaining({ code: 'BLOGGER_PROFILE_INVALID', message: expect.stringMatching(expected) as string }))
  })

  it('surfaces a model failure with the provider code', async () => {
    const { ctx } = await mountLlm([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'STUB_UPSTREAM' } } },
    ])
    await expect(distillProfile(ctx, { maxPromptTokens: 100_000, maxOutputTokens: 4_000 }, {
      corpus: CORPUS, route: { provider: 'stub-provider', model: 'stub-model' }, notesRoot: '/notes', signal: testSignal,
    })).rejects.toThrow(expect.objectContaining({ code: 'STUB_UPSTREAM', message: expect.stringContaining('upstream exploded') as string }))
  })
})

describe('skillDirectory', () => {
  it('appends the blogger display name so the root shows whose skill it is', () => {
    expect(skillDirectory('tgb-134434', '炒股养家')).toBe('tgb-134434-炒股养家')
  })

  it('falls back to the skill name when the platform exposes no display name', () => {
    expect(skillDirectory('tgb-134434', undefined)).toBe('tgb-134434')
  })

  it('replaces any character a directory name may not carry', () => {
    expect(skillDirectory('tgb-134434', 'Stub / Blogger: "quoted"?')).toBe('tgb-134434-Stub-Blogger-quoted')
  })

  it('falls back to the skill name when sanitizing leaves nothing', () => {
    expect(skillDirectory('tgb-134434', '   ')).toBe('tgb-134434')
  })
})

describe('writeSkillFile', () => {
  it('writes the procedure and its portrait under the given directory', async () => {
    const root = tempRoot('blogger-skill')
    try {
      const ctx = new Context()
      await ctx.plugin(LocalFileSystem)
      const written = await writeSkillFile(ctx, root.path, 'tgb-134434-炒股养家', {
        name: 'stub-blogger',
        description: 'A stub.',
        skill: '- Act.',
        portrait: '# Portrait',
      }, testSignal)

      expect(written.skillPath).toBe(join(root.path, 'tgb-134434-炒股养家', 'SKILL.md'))
      expect(written.portraitPath).toBe(join(root.path, 'tgb-134434-炒股养家', 'portrait.md'))
      await expect(ctx.fs.readText(await ctx.fs.resolve(written.skillPath))).resolves.toContain('name: stub-blogger')
      await expect(ctx.fs.readText(await ctx.fs.resolve(written.portraitPath))).resolves.toBe('# Portrait\n')
    } finally {
      root.remove()
    }
  })
})
