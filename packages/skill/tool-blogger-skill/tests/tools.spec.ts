/**
 * Real composition test: the tool-blogger-skill plugin boots through the real
 * Loader unwrap path onto a real tool registry, a real blogger registry, a real
 * filesystem, and a real LLM runtime, and both tools run end-to-end with only
 * the platform source and the model stubbed. Also guards the namespace export
 * shape (see the tool-web postmortem: a default export would collapse the
 * namespace and drop `inject`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { BloggerPostSummary, BloggerReply } from '@deepseek-ai/dsh-blogger'
import BloggerSourceRegistry from '@deepseek-ai/dsh-blogger'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolBloggerSkill from '@deepseek-ai/dsh-tool-blogger-skill'
import { resolveRoot } from '../src/tools.ts'
import type { TempRoot, StubIdentity } from './helpers.ts'
import { profileAnswer, ScriptedAdapter, STUB_POSTS, STUB_REPLIES, StubBloggerSource, tempRoot, textResponse } from './helpers.ts'

const testSignal = new AbortController().signal

const USER = '905478'

/** What one mounted stack answers with on the platform side and the model side. */
interface MountOptions {
  /** Overrides merged into the plugin config. */
  readonly config?: Record<string, unknown>
  /** The model's scripted answer. */
  readonly script?: string
  /** The source's post list. */
  readonly posts?: BloggerPostSummary[]
  /** The source's reply list. */
  readonly replies?: BloggerReply[]
  /** The identity facts the source reports. */
  readonly identity?: StubIdentity
  /** A corpus JSON pre-seeded at the blogger's path, as an earlier harvest left it. */
  readonly storedCorpus?: string
  /** Whether the platform reports further pages on every list. */
  readonly hasMore?: boolean
}

interface Harness {
  readonly ctx: Context
  readonly source: StubBloggerSource
  readonly root: TempRoot
  readonly skillsRoot: string
  readonly call: (name: string, args: unknown) => Promise<ToolExecutionResult>
}

const harnesses: Harness[] = []

/** Mount the whole stack over one temp workspace. */
async function mount(options: MountOptions = {}): Promise<Harness> {
  const root = tempRoot('blogger-tools')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(BloggerSourceRegistry)
  const source = new StubBloggerSource(options.posts ?? STUB_POSTS, options.replies ?? STUB_REPLIES, options.identity, options.hasMore)
  ctx.bloggers.register(source)
  ctx.llm.registerAdapter(['stub-provider'], new ScriptedAdapter(textResponse(options.script ?? profileAnswer())))

  const loader = Object.create(Loader.prototype) as Loader
  const unwrapped = loader.unwrapExports(toolBloggerSkill) as Parameters<Context['plugin']>[0]
  const skillsRoot = join(root.path, 'skills')
  const corpusRoot = join(root.path, 'corpora')
  await ctx.plugin(unwrapped, {
    provider: 'stub-provider',
    model: 'stub-model',
    corpusRoot,
    skillsRoot,
    ...options.config,
  })
  if (options.storedCorpus !== undefined) {
    mkdirSync(corpusRoot, { recursive: true })
    writeFileSync(join(corpusRoot, `stub-${USER}.json`), options.storedCorpus)
  }

  let counter = 0
  const harness: Harness = {
    ctx,
    source,
    root,
    skillsRoot,
    call: (name, args) => ctx.tools.execute({
      signal: testSignal,
      callId: ToolCallId(`${name}-${++counter}`),
      name,
      arguments: args,
    }),
  }
  harnesses.push(harness)
  return harness
}

/** Mount the plugin alone, without the rest of the stack. */
async function mountPlugin(config: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(BloggerSourceRegistry)
  const loader = Object.create(Loader.prototype) as Loader
  const unwrapped = loader.unwrapExports(toolBloggerSkill) as Parameters<Context['plugin']>[0]
  await ctx.plugin(unwrapped, config)
  return ctx
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.root.remove()
})

describe('dsh-tool-blogger-skill composition', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolBloggerSkill).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolBloggerSkill) as Record<string, unknown>
    expect(unwrapped).toBe(toolBloggerSkill)
    expect(unwrapped.name).toBe('tool-blogger-skill')
    expect(unwrapped.inject).toEqual(['tools', 'bloggers', 'llm', 'fs'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('registers both tools and disposes them with the fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(BloggerSourceRegistry)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolBloggerSkill) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { provider: 'stub-provider', model: 'stub-model' })

    expect(ctx.tools.schemas().map(schema => schema.name))
      .toEqual(expect.arrayContaining(['blogger_harvest', 'blogger_build_skill']))
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('blogger_harvest')
  })

  it('rejects a config that names only one half of the model route', async () => {
    await expect(mountPlugin({ provider: 'stub-provider' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BLOGGER_CONFIG_INVALID' }))
    await expect(mountPlugin({ model: 'stub-model' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BLOGGER_CONFIG_INVALID' }))
  })

  it('inherits the session route when the config names no model', async () => {
    const ctx = await mountPlugin({})
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('blogger_build_skill')
  })

  it('declares an exclusive card for both tools', async () => {
    const { ctx } = await mount()
    const harvest = ctx.tools.get('blogger_harvest')
    const build = ctx.tools.get('blogger_build_skill')

    expect(harvest?.isConcurrencySafe?.({ user: USER })).toBe(false)
    expect(build?.isConcurrencySafe?.({ user: USER })).toBe(false)
    expect(harvest?.presentCall?.({ user: USER })).toMatchObject({ card: 'generic', title: `harvest blogger ${USER}` })
    expect(build?.presentCall?.({ user: USER })).toMatchObject({ card: 'generic', title: `build skill for blogger ${USER}` })
  })
})

describe('blogger_harvest', () => {
  it('collects posts, bodies, and replies into a corpus file', async () => {
    const { call } = await mount()
    const out = await call('blogger_harvest', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({
      source: 'stub',
      userID: USER,
      userName: 'Stub Blogger',
      profileUrl: `https://stub.example/${USER}`,
      posts: 2,
      postsWithBody: 2,
      replies: 2,
      newPosts: 2,
      newReplies: 2,
      postStartPage: 1,
      postPagesFetched: 1,
      postHasMore: false,
      replyStartPage: 1,
      replyPagesFetched: 1,
      replyHasMore: false,
    })
    expect(out.value).not.toHaveProperty('nextPostPage')
    expect(out.value).not.toHaveProperty('nextReplyPage')

    const stored = JSON.parse(readFileSync((out.value as { corpusPath: string }).corpusPath, 'utf8')) as {
      posts: { bodyMarkdown?: string }[]
      userName?: string
    }
    expect(stored.posts.map(post => post.bodyMarkdown)).toEqual(['body of codeA', 'body of codeB'])
    expect(stored.userName).toBe('Stub Blogger')
  })

  it('re-harvesting adds nothing and refetches no stored body', async () => {
    const { call, source } = await mount()
    await call('blogger_harvest', { user: USER })
    source.calls.length = 0

    const out = await call('blogger_harvest', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ posts: 2, postsWithBody: 2, newPosts: 0, newReplies: 0 })
    expect(source.calls).toEqual(['posts:1', 'replies:1'])
  })

  it('accepts an explicit source id and explicit page budgets', async () => {
    const { call, source } = await mount()
    const out = await call('blogger_harvest', { user: USER, source: 'stub', postPages: 1, replyPages: 1, maxPosts: 1 })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ postsWithBody: 1 })
    expect(source.calls).toEqual(['posts:1', 'post:codeA', 'replies:1'])
  })

  it('rejects a page budget above the configured ceiling', async () => {
    const { call } = await mount()
    const out = await call('blogger_harvest', { user: USER, postPages: 99 })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.message).toContain('postPages must be at most 3')
  })

  it('rejects a page budget below one', async () => {
    const { call } = await mount()
    const out = await call('blogger_harvest', { user: USER, replyPages: 0 })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.message).toContain('replyPages must be a positive integer')
  })

  it('fails BLOGGER_SOURCE_UNRECOGNIZED on a reference no source recognizes', async () => {
    const { call } = await mount()
    const out = await call('blogger_harvest', { user: 'no-such-blogger' })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_SOURCE_UNRECOGNIZED')
  })

  it('fails BLOGGER_SOURCE_UNKNOWN on a named source that is not registered', async () => {
    const { call } = await mount()
    const out = await call('blogger_harvest', { user: USER, source: 'nowhere' })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_SOURCE_UNKNOWN')
  })

  it('cuts a rendered output at the configured cap', async () => {
    const { call } = await mount({ config: { maxOutputChars: 120 } })
    const out = await call('blogger_harvest', { user: USER })

    expect(out.isError).toBe(false)
    expect(out.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('(Output truncated.') as string })
  })

  it('hard-slices an output cap below the truncation notice', async () => {
    const { call } = await mount({ config: { maxOutputChars: 20 } })
    const out = await call('blogger_harvest', { user: USER })

    expect(out.isError).toBe(false)
    expect(out.content[0]).toEqual({ type: 'text', text: 'Harvested stub blogg' })
  })

  it('reports a blogger whose platform exposes neither a display name nor a profile URL', async () => {
    const { call } = await mount({ identity: {} })
    const out = await call('blogger_harvest', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).not.toHaveProperty('userName')
    expect(out.value).not.toHaveProperty('profileUrl')
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining(`Harvested stub blogger ${USER} — `) as string })
  })

  it('tells the model when the platform held further pages, and where to resume', async () => {
    const { call } = await mount({ hasMore: true })
    const out = await call('blogger_harvest', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ nextPostPage: 2, nextReplyPage: 2 })
    expect(out.content[0]).toMatchObject({
      text: expect.stringContaining('call again with postStartPage: 2 and replyStartPage: 2.') as string,
    })
  })

  it('starts each list at the page the model named and reports the next one', async () => {
    const { call, source } = await mount({ hasMore: true })
    await call('blogger_harvest', { user: USER })
    source.calls.length = 0

    const out = await call('blogger_harvest', { user: USER, postStartPage: 4, replyStartPage: 7 })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(source.calls).toEqual(['posts:4', 'replies:7'])
    expect(out.value).toMatchObject({
      postStartPage: 4,
      replyStartPage: 7,
      nextPostPage: 5,
      nextReplyPage: 8,
    })
    expect(out.content[0]).toMatchObject({ text: expect.stringContaining('post page(s) 4–4') as string })
  })

  it('rejects a start page below one', async () => {
    const { call } = await mount()
    const posts = await call('blogger_harvest', { user: USER, postStartPage: 0 })
    const replies = await call('blogger_harvest', { user: USER, replyStartPage: 0 })

    expect(posts.isError).toBe(true)
    expect(replies.isError).toBe(true)
    if (!posts.isError) return
    expect(posts.error.message).toContain('postStartPage must be a positive integer')
    if (!replies.isError) return
    expect(replies.error.message).toContain('replyStartPage must be a positive integer')
  })

  it('keeps a display name an earlier corpus already learned', async () => {
    const { call } = await mount({
      identity: {},
      storedCorpus: JSON.stringify({
        source: 'stub',
        userID: USER,
        userName: 'Remembered Name',
        profileUrl: `https://stub.example/${USER}`,
        updatedAt: '2025-01-01T00:00:00.000Z',
        posts: [],
        replies: [],
      }),
    })
    const out = await call('blogger_harvest', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ userName: 'Remembered Name', profileUrl: `https://stub.example/${USER}` })
  })
})

describe('blogger_build_skill', () => {
  it('distills a harvested corpus into a SKILL.md under the skill root', async () => {
    const { call, skillsRoot } = await mount()
    await call('blogger_harvest', { user: USER })

    const out = await call('blogger_build_skill', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({
      source: 'stub',
      userID: USER,
      userName: 'Stub Blogger',
      skillName: 'stub-blogger-buy-the-dip',
      description: 'Consult when judging a stub blogger\'s dip-buying rules.',
      posts: 2,
      postsWithBody: 2,
      replies: 2,
      digestTruncated: false,
    })
    const path = join(skillsRoot, 'stub-blogger-buy-the-dip', 'SKILL.md')
    expect((out.value as { skillPath: string }).skillPath).toBe(path)
    const file = readFileSync(path, 'utf8')
    expect(file.startsWith('---\nname: stub-blogger-buy-the-dip\n')).toBe(true)
    expect(file).toContain('Wait for volume before buying.')
  })

  it('honours an explicit skill name', async () => {
    const { call, skillsRoot } = await mount()
    await call('blogger_harvest', { user: USER })

    const out = await call('blogger_build_skill', { user: USER, skillName: 'my-stub-profile' })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ skillName: 'my-stub-profile' })
    expect(readFileSync(join(skillsRoot, 'my-stub-profile', 'SKILL.md'), 'utf8')).toContain('my-stub-profile')
  })

  it('rejects a skill name outside the skill grammar', async () => {
    const { call } = await mount()
    await call('blogger_harvest', { user: USER })

    const out = await call('blogger_build_skill', { user: USER, skillName: 'Not A Name' })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_PROFILE_INVALID')
  })

  it('fails BLOGGER_CORPUS_MISSING before any harvest', async () => {
    const { call } = await mount()
    const out = await call('blogger_build_skill', { user: USER })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_CORPUS_MISSING')
  })

  it('fails BLOGGER_CORPUS_EMPTY when the harvest collected nothing', async () => {
    const { call } = await mount({ posts: [], replies: [] })
    await call('blogger_harvest', { user: USER })

    const out = await call('blogger_build_skill', { user: USER })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_CORPUS_EMPTY')
  })

  it('fails BLOGGER_PROFILE_INVALID when the model answers off-format', async () => {
    const { call } = await mount({ script: 'I have no opinion.' })
    await call('blogger_harvest', { user: USER })

    const out = await call('blogger_build_skill', { user: USER })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_PROFILE_INVALID')
  })

  it('reports a truncated digest when the corpus exceeds the prompt budget', async () => {
    const { call } = await mount({ config: { maxPromptChars: 30 } })
    await call('blogger_harvest', { user: USER })

    const out = await call('blogger_build_skill', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ digestTruncated: true })
  })

  it('builds a skill for a blogger with no display name', async () => {
    const { call, skillsRoot } = await mount({ identity: {} })
    await call('blogger_harvest', { user: USER })

    const out = await call('blogger_build_skill', { user: USER })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).not.toHaveProperty('userName')
    expect(readFileSync(join(skillsRoot, 'stub-blogger-buy-the-dip', 'SKILL.md'), 'utf8')).toContain('name: stub-blogger-buy-the-dip')
  })
})

describe('resolveRoot', () => {
  it('returns an absolute configured root unchanged', () => {
    const absolute = join(process.cwd(), 'already-absolute')
    expect(resolveRoot(absolute, process.cwd())).toBe(absolute)
  })

  it('resolves a relative root against the session workspace, or the process when there is none', () => {
    expect(resolveRoot(join('.dsh', 'skills'), process.cwd())).toBe(join(process.cwd(), '.dsh', 'skills'))
    expect(resolveRoot('relative-root', undefined)).toBe(join(process.cwd(), 'relative-root'))
  })
})
