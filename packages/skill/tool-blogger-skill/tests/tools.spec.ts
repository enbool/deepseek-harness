/**
 * Real composition test: the tool-blogger-skill plugin boots through the real
 * Loader unwrap path onto a real tool registry, a real blogger registry, a real
 * filesystem, and a real LLM runtime, and both tools run end-to-end with only
 * the platform source and the model stubbed. Also guards the namespace export
 * shape (see the tool-web postmortem: a default export would collapse the
 * namespace and drop `inject`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
import { resolveRoot, formatIngest, LOCAL_SOURCE } from '../src/tools.ts'
import type { IngestValue } from '../src/tools.ts'
import type { TempRoot, StubIdentity } from './helpers.ts'
import { profileAnswer, RoutingAdapter, STUB_POSTS, STUB_REPLIES, StubBloggerSource, tempRoot } from './helpers.ts'

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
  ctx.llm.registerAdapter(['stub-provider'], new RoutingAdapter(undefined, options.script ?? profileAnswer()))

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
    const ingest = ctx.tools.get('blogger_ingest_documents')

    expect(harvest?.isConcurrencySafe?.({ user: USER })).toBe(false)
    expect(build?.isConcurrencySafe?.({ user: USER })).toBe(false)
    expect(ingest?.isConcurrencySafe?.({ user: USER, documents: [] })).toBe(false)
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
      passes: 2,
      notesReused: 0,
    })
    const path = join(skillsRoot, 'stub-blogger-buy-the-dip-Stub-Blogger', 'SKILL.md')
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
    expect(readFileSync(join(skillsRoot, 'my-stub-profile-Stub-Blogger', 'SKILL.md'), 'utf8')).toContain('my-stub-profile')
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

  it('reads a corpus beyond the request budget in windows and reuses their notes', async () => {
    const replies = Array.from({ length: 20 }, (_, index) => ({
      id: `codeA/${index}`,
      url: `https://stub.example/a/codeA/${index}`,
      topicTitle: 'Someone else',
      topicUrl: 'https://stub.example/a/other',
      repliedAt: '2026-01-03 09:00',
      body: '追涨杀跌'.repeat(20),
    }))
    const { call } = await mount({ config: { maxPromptTokens: 400 }, replies })
    await call('blogger_harvest', { user: USER })

    const first = await call('blogger_build_skill', { user: USER })
    const second = await call('blogger_build_skill', { user: USER })

    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    if (first.isError || second.isError) return
    expect((first.value as { passes: number }).passes).toBeGreaterThan(2)
    expect(second.value).toMatchObject({ passes: 2 })
    expect((second.value as { notesReused: number }).notesReused).toBeGreaterThan(0)
    expect(second.content[0]).toMatchObject({
      text: expect.stringContaining('window note(s) reused from') as string,
    })
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

describe('LOCAL_SOURCE', () => {
  it('matches only its own local: references', () => {
    expect(LOCAL_SOURCE.matches('local:炒股养家')).toBe(true)
    expect(LOCAL_SOURCE.matches('  local:someone  ')).toBe(true)
    expect(LOCAL_SOURCE.matches(USER)).toBe(false)
    expect(LOCAL_SOURCE.matches('https://stub.example/905478')).toBe(false)
  })

  it('resolves a trimmed handle and rejects an empty one', async () => {
    await expect(LOCAL_SOURCE.resolve('local: 炒股养家 ', testSignal)).resolves.toEqual({ source: 'local', userID: '炒股养家' })
    expect(() => LOCAL_SOURCE.resolve('local:', testSignal))
      .toThrow(expect.objectContaining({
        code: 'BLOGGER_DOCUMENT_INVALID',
        message: expect.stringContaining('needs a handle') as string,
      }))
  })

  it('lists nothing and holds no platform posts', async () => {
    const ref = await LOCAL_SOURCE.resolve('local:炒股养家', testSignal)
    const request = { pageNo: 1, maxPages: 1, signal: testSignal }

    await expect(LOCAL_SOURCE.listPosts(ref, request))
      .resolves.toEqual({ items: [], pageNo: 1, pagesFetched: 0, hasMore: false })
    await expect(LOCAL_SOURCE.listReplies(ref, request))
      .resolves.toEqual({ items: [], pageNo: 1, pagesFetched: 0, hasMore: false })
    await expect(LOCAL_SOURCE.fetchPost(ref, 'codeA', testSignal))
      .rejects.toThrow(expect.objectContaining({
        code: 'BLOGGER_DOCUMENT_INVALID',
        message: expect.stringContaining('holds no platform posts') as string,
      }))
  })
})

describe('formatIngest', () => {
  const VALUE: IngestValue = {
    source: 'local',
    userID: 'handle',
    corpusPath: '/corpora/local-handle.json',
    documentsRead: 2,
    postsIngested: 1,
    repliesIngested: 1,
    posts: 3,
    replies: 4,
    offlinePosts: 1,
    offlineReplies: 1,
  }

  /** The line a platform blogger whose corpus holds no platform record gets. */
  const NO_PLATFORM_HISTORY = 'No platform history is stored for handle yet. Run blogger_harvest for it to collect that history into this same corpus, then distil; documents alone are only the material the platform no longer carries.'

  it('renders the counts, the corpus path, and the next step', () => {
    expect(formatIngest(VALUE)).toBe([
      'Ingested 2 document(s) into local blogger handle: 1 post(s), 1 reply/replies.',
      'Corpus now holds 3 post(s) and 4 reply/replies, of which 1 and 1 came from documents.',
      'Corpus: /corpora/local-handle.json',
      'Run blogger_build_skill to distil it.',
    ].join('\n'))
  })

  it('names the display name once the corpus learned one', () => {
    expect(formatIngest({ ...VALUE, userName: '炒股养家' })).toContain('into local blogger handle (炒股养家):')
  })

  it('omits the platform-history line for a local blogger whose corpus holds only documents', () => {
    const local = formatIngest({ ...VALUE, posts: 1, replies: 0, offlinePosts: 1, offlineReplies: 0 })

    expect(local).not.toContain('No platform history is stored')
    expect(local).toContain('Corpus: /corpora/local-handle.json')
  })

  it('adds the platform-history line for a platform blogger whose corpus holds only documents', () => {
    const platformOnly = formatIngest({
      ...VALUE,
      source: 'tgb',
      posts: 1,
      replies: 0,
      offlinePosts: 1,
      offlineReplies: 0,
    })

    expect(platformOnly).toContain(NO_PLATFORM_HISTORY)
    expect(platformOnly.indexOf(NO_PLATFORM_HISTORY)).toBeLessThan(platformOnly.indexOf('Corpus: /corpora/local-handle.json'))
  })

  it('omits the platform-history line for a platform blogger whose corpus holds platform records too', () => {
    const withPlatform = formatIngest({ ...VALUE, source: 'tgb' })

    expect(withPlatform).not.toContain('No platform history is stored')
    expect(withPlatform).toContain('of which 1 and 1 came from documents.')
  })
})

describe('blogger_ingest_documents', () => {
  /** Write one markdown document under a harness workspace. */
  function writeDocument(harness: Harness, name: string, text: string): string {
    const path = join(harness.root.path, name)
    writeFileSync(path, text)
    return path
  }

  it('folds a markdown document into an existing platform corpus', async () => {
    const harness = await mount()
    await harness.call('blogger_harvest', { user: USER })
    const document = writeDocument(harness, 'deleted-call.md', [
      '---',
      'title: A deleted call',
      'publishedAt: 2025-06-12',
      '---',
      '',
      'Sell into strength.',
    ].join('\n'))

    const out = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({
      source: 'stub',
      userID: USER,
      userName: 'Stub Blogger',
      documentsRead: 1,
      postsIngested: 1,
      repliesIngested: 0,
      posts: 3,
      replies: 2,
      offlinePosts: 1,
      offlineReplies: 0,
    })

    const stored = JSON.parse(readFileSync((out.value as { corpusPath: string }).corpusPath, 'utf8')) as {
      posts: { id: string; origin?: string; documentPath?: string; title?: string }[]
    }
    expect(stored.posts.find(post => post.id === `offline:${basename(document)}`))
      .toMatchObject({ origin: 'offline', documentPath: document, title: 'A deleted call' })
    expect((out.content[0] as { text: string }).text).not.toContain('No platform history is stored')
  })

  it('collapses two documents that share a file name in different directories into one record', async () => {
    const harness = await mount()
    const directory = join(harness.root.path, 'archive')
    mkdirSync(directory, { recursive: true })
    const first = writeDocument(harness, 'same-name.md', '---\ntitle: First copy\n---\nfirst body')
    const moved = join(directory, 'same-name.md')
    writeFileSync(moved, '---\ntitle: Second copy\n---\nsecond body')

    const firstOut = await harness.call('blogger_ingest_documents', { user: USER, documents: [first] })
    const secondOut = await harness.call('blogger_ingest_documents', { user: USER, documents: [moved] })

    expect(firstOut.isError).toBe(false)
    expect(secondOut.isError).toBe(false)
    if (firstOut.isError || secondOut.isError) return
    expect(firstOut.value).toMatchObject({ posts: 1, offlinePosts: 1 })
    expect(secondOut.value).toMatchObject({ posts: 1, offlinePosts: 1 })
    const stored = JSON.parse(readFileSync((secondOut.value as { corpusPath: string }).corpusPath, 'utf8')) as {
      posts: { id: string; documentPath?: string; title?: string }[]
    }
    expect(stored.posts).toEqual([
      expect.objectContaining({ id: 'offline:same-name.md', documentPath: moved, title: 'Second copy' }),
    ])
  })

  it('replaces a record re-ingested from an edited document under the same file name', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'edited.md', '---\ntitle: Before\npublishedAt: 2025-01-01\n---\nfirst body')
    await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })
    writeFileSync(document, '---\ntitle: After\npublishedAt: 2025-01-01\n---\nsecond body')

    const out = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ posts: 1, offlinePosts: 1 })
    const stored = JSON.parse(readFileSync((out.value as { corpusPath: string }).corpusPath, 'utf8')) as {
      posts: { id: string; title?: string; bodyMarkdown?: string }[]
    }
    expect(stored.posts).toEqual([
      expect.objectContaining({ id: 'offline:edited.md', title: 'After', bodyMarkdown: 'second body' }),
    ])
  })

  it('tells the model a platform blogger holds no platform history yet', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'only-offline.md', 'body')

    const out = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ source: 'stub', posts: 1, replies: 0, offlinePosts: 1, offlineReplies: 0 })
    expect((out.content[0] as { text: string }).text).toContain(
      `No platform history is stored for ${USER} yet. Run blogger_harvest for it to collect that history into this same corpus, `
      + 'then distil; documents alone are only the material the platform no longer carries.',
    )
  })

  it('ingests into a local blogger that has no platform history', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'local-post.md', '# 一个离线帖子\n\n内容。')

    const out = await harness.call('blogger_ingest_documents', {
      user: 'local:炒股养家',
      userName: '炒股养家',
      documents: [document],
    })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({
      source: 'local',
      userID: '炒股养家',
      userName: '炒股养家',
      posts: 1,
      replies: 0,
      offlinePosts: 1,
      offlineReplies: 0,
    })
    expect(out.content[0]).toMatchObject({
      text: expect.stringContaining('Ingested 1 document(s) into local blogger 炒股养家 (炒股养家): 1 post(s), 0 reply/replies.') as string,
    })
    expect((out.content[0] as { text: string }).text).not.toContain('No platform history is stored')
  })

  it('re-ingests an unchanged document without duplicating its record', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'once.md', '---\nplatformId: codeZ\npublishedAt: 2025-01-01\n---\nbody')

    const first = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })
    const second = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })

    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    if (first.isError || second.isError) return
    expect(second.value).toMatchObject({ documentsRead: 1, postsIngested: 1, posts: 1, offlinePosts: 1 })
  })

  it('files a document whose frontmatter names it a reply', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'answer.md', [
      '---',
      'kind: reply',
      'publishedAt: 2025-07-01',
      'topicTitle: Someone else',
      'topicUrl: https://stub.example/a/other',
      '---',
      'Wait for volume.',
    ].join('\n'))

    const out = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).toMatchObject({ postsIngested: 0, repliesIngested: 1, offlinePosts: 0, offlineReplies: 1 })
  })

  it('uses the kind argument for a document whose frontmatter names none', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'unclassified.md', 'body with no frontmatter')

    const asPost = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })
    const asReply = await harness.call('blogger_ingest_documents', { user: USER, documents: [document], kind: 'reply' })

    expect(asPost.isError).toBe(false)
    expect(asReply.isError).toBe(false)
    if (asPost.isError || asReply.isError) return
    expect(asPost.value).toMatchObject({ postsIngested: 1, repliesIngested: 0, offlinePosts: 1 })
    expect(asReply.value).toMatchObject({ postsIngested: 0, repliesIngested: 1, offlineReplies: 1 })
  })

  it('fails BLOGGER_DOCUMENT_INVALID on a local reference with no handle', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'handleless.md', 'body')

    const out = await harness.call('blogger_ingest_documents', { user: 'local:', documents: [document] })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_DOCUMENT_INVALID')
  })

  it('fails BLOGGER_DOCUMENT_INVALID on a document with no body', async () => {
    const harness = await mount()
    const document = writeDocument(harness, 'empty.md', '---\ntitle: Empty\n---\n')

    const out = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })

    expect(out.isError).toBe(true)
    if (!out.isError) return
    expect(out.error.info?.code).toBe('BLOGGER_DOCUMENT_INVALID')
  })

  it('stores no display name for a blogger neither the source nor the corpus names', async () => {
    const harness = await mount({ identity: {} })
    const document = writeDocument(harness, 'nameless.md', 'body')

    const out = await harness.call('blogger_ingest_documents', { user: USER, documents: [document] })

    expect(out.isError).toBe(false)
    if (out.isError) return
    expect(out.value).not.toHaveProperty('userName')
    expect(out.content[0]).toMatchObject({
      text: expect.stringContaining(`Ingested 1 document(s) into stub blogger ${USER}:`) as string,
    })
  })
})
