/**
 * The two model-facing blogger tools. `blogger_harvest` resolves a platform
 * reference, collects that blogger's posts, post bodies, and replies through
 * `ctx.bloggers`, and merges them into a durable corpus. `blogger_build_skill`
 * reads that corpus, distills it through `ctx.llm`, and writes the result as a
 * `SKILL.md` under the configured skill root. Both are read-only over the
 * platform; only the local corpus and skill files are written.
 * @module @deepseek-ai/dsh-tool-blogger-skill/tools
 */

import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BloggerPostSummary, BloggerRef, BloggerResolution, BloggerSource } from '@deepseek-ai/dsh-blogger'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BloggerCorpusStore } from './corpus.ts'
import type { CorpusBounds, HarvestedCorpus } from './corpus.ts'
import { BLOGGER_CORPUS_EMPTY, BLOGGER_CORPUS_MISSING, BLOGGER_DOCUMENT_INVALID, BLOGGER_PROFILE_INVALID, BloggerSkillError } from './errors.ts'
import { distillProfile, resolveRoute, skillDirectory, writeSkillFile } from './profile.ts'
import type { DistillLimits, ModelRoute } from './profile.ts'
import type { BloggerCorpus, CorpusPost, CorpusReply } from './types.ts'
import { documentPost, documentReply, parseDocument } from './documents.ts'

/** The reference prefix that selects the offline source, as in `local:炒股养家`. */
export const LOCAL_PREFIX = 'local:'

/**
 * The source that gives an offline-only blogger an identity. A blogger whose
 * platform history was deleted, or who never had one, still needs a reference
 * `ctx.bloggers.resolve` can carry to a corpus, and the documents themselves
 * arrive through `blogger_ingest_documents`. It holds no platform data, so it
 * matches only its own `local:` references and never claims a platform blogger's.
 */
export const LOCAL_SOURCE: BloggerSource = {
  id: 'local',
  displayName: '离线文档',
  matches: input => input.trim().startsWith(LOCAL_PREFIX),
  resolve: (input) => {
    const handle = input.trim().slice(LOCAL_PREFIX.length).trim()
    if (handle.length === 0) {
      throw new BloggerSkillError('a local blogger reference needs a handle, as in local:炒股养家', BLOGGER_DOCUMENT_INVALID)
    }
    return Promise.resolve({ source: 'local', userID: handle })
  },
  listPosts: () => Promise.resolve({ items: [], pageNo: 1, pagesFetched: 0, hasMore: false }),
  listReplies: () => Promise.resolve({ items: [], pageNo: 1, pagesFetched: 0, hasMore: false }),
  fetchPost: () => Promise.reject(new BloggerSkillError(
    'the local source holds no platform posts; fold offline documents in with blogger_ingest_documents',
    BLOGGER_DOCUMENT_INVALID,
  )),
}

/** One document intake's result, as the model sees it. */
export interface IngestValue {
  /** The source id the corpus belongs to. */
  readonly source: string
  /** The blogger's user id on that source. */
  readonly userID: string
  /** The blogger's display name, once known. */
  readonly userName?: string
  /** Absolute corpus file path. */
  readonly corpusPath: string
  /** How many documents this call read. */
  readonly documentsRead: number
  /** How many post records this call contributed. */
  readonly postsIngested: number
  /** How many reply records this call contributed. */
  readonly repliesIngested: number
  /** Posts the corpus now holds. */
  readonly posts: number
  /** Replies the corpus now holds. */
  readonly replies: number
  /** Of those posts, how many came from documents. */
  readonly offlinePosts: number
  /** Of those replies, how many came from documents. */
  readonly offlineReplies: number
}

/**
 * Render one document intake's result for the model.
 *
 * @param value - the tool's value.
 * @returns the rendered text.
 */
export function formatIngest(value: IngestValue): string {
  const who = `${value.source} blogger ${value.userID}${value.userName === undefined ? '' : ` (${value.userName})`}`
  const platform = (value.posts - value.offlinePosts) + (value.replies - value.offlineReplies)
  return [
    `Ingested ${value.documentsRead} document(s) into ${who}: ${value.postsIngested} post(s), ${value.repliesIngested} reply/replies.`,
    `Corpus now holds ${value.posts} post(s) and ${value.replies} reply/replies, of which ${value.offlinePosts} and ${value.offlineReplies} came from documents.`,
    ...platform === 0 && value.source !== 'local'
      ? [`No platform history is stored for ${value.userID} yet. Run blogger_harvest for it to collect that history into this same corpus, then distil; documents alone are only the material the platform no longer carries.`]
      : [],
    `Corpus: ${value.corpusPath}`,
    'Run blogger_build_skill to distil it.',
  ].join('\n')
}

/** Deployment-owned bounds the blogger tools render, paginate, and distill under. */
export interface BloggerToolLimits extends CorpusBounds, DistillLimits {
  /** Page budget for one harvest's post collection. */
  readonly maxPostPages: number
  /** Page budget for one harvest's reply collection. */
  readonly maxReplyPages: number
  /** Post bodies one harvest may fetch. */
  readonly maxPosts: number
  /** Cap on one complete rendered tool output (characters). */
  readonly maxOutputChars: number
  /** Cooperative tool-call timeout budget (ms). */
  readonly timeoutMs: number
}

/** Deployment-owned filesystem and model configuration the tools read. */
export interface BloggerToolOptions {
  /** Directory the skill files are written under. */
  readonly skillsRoot: string
  /** Directory the corpora are stored under. */
  readonly corpusRoot: string
  /** Explicit distillation model route; both fields are set together or neither is. */
  readonly route: { readonly provider?: string; readonly model?: string }
}

/** The `blogger_harvest` canonical output value. */
export interface HarvestValue {
  /** The source that recognized the reference. */
  readonly source: string
  /** The blogger's user id on that source. */
  readonly userID: string
  /** Display name, when the source or a stored corpus knows it. */
  readonly userName?: string
  /** Absolute profile page URL, when the source exposes one. */
  readonly profileUrl?: string
  /** Absolute corpus file path. */
  readonly corpusPath: string
  /** Posts the corpus now holds. */
  readonly posts: number
  /** Of those, how many carry a body. */
  readonly postsWithBody: number
  /** Replies the corpus now holds. */
  readonly replies: number
  /** Posts this call had not stored before. */
  readonly newPosts: number
  /** Replies this call had not stored before. */
  readonly newReplies: number
  /** The 1-based post page this call started from. */
  readonly postStartPage: number
  /** Post pages this call fetched. */
  readonly postPagesFetched: number
  /** Whether the source held further post pages. */
  readonly postHasMore: boolean
  /** The post page to pass as `postStartPage` next, present only while more remain. */
  readonly nextPostPage?: number
  /** The 1-based reply page this call started from. */
  readonly replyStartPage: number
  /** Reply pages this call fetched. */
  readonly replyPagesFetched: number
  /** Whether the source held further reply pages. */
  readonly replyHasMore: boolean
  /** The reply page to pass as `replyStartPage` next, present only while more remain. */
  readonly nextReplyPage?: number
}

/** The `blogger_build_skill` canonical output value. */
export interface BuildSkillValue {
  /** The source the corpus came from. */
  readonly source: string
  /** The blogger's user id on that source. */
  readonly userID: string
  /** Display name, when known. */
  readonly userName?: string
  /** The written skill's kebab-case name. */
  readonly skillName: string
  /** Absolute path of the written `SKILL.md` holding the operating procedure. */
  readonly skillPath: string
  /** Absolute path of the written evidence portrait beside it. */
  readonly portraitPath: string
  /** The written description, as it appears in the skill's frontmatter. */
  readonly description: string
  /** Posts the corpus held. */
  readonly posts: number
  /** Of those, how many carried a body. */
  readonly postsWithBody: number
  /** Replies the corpus held. */
  readonly replies: number
  /** Characters of corpus evidence sent across every distillation pass. */
  readonly evidenceChars: number
  /** Model requests the distillation made: one per window, plus the merge. */
  readonly passes: number
  /** Windows whose evidence notes were reused from disk. */
  readonly notesReused: number
  /** Directory holding the per-window evidence notes. */
  readonly notesPath: string
}

/** The footer appended when a rendered output was cut. */
const TRUNCATION_FOOTER = '\n\n(Output truncated. Narrow the request — fewer pages or fewer posts — for the rest.)'

/**
 * Bound one rendered output to the configured cap.
 *
 * @param text - the complete rendered text.
 * @param maxOutputChars - the cap on the complete returned string.
 * @returns the content blocks carrying the bounded text.
 */
function boundedText(text: string, maxOutputChars: number): ContentBlock[] {
  if (text.length <= maxOutputChars) return [{ type: 'text', text }]
  if (maxOutputChars <= TRUNCATION_FOOTER.length) return [{ type: 'text', text: text.slice(0, maxOutputChars) }]
  return [{ type: 'text', text: `${text.slice(0, maxOutputChars - TRUNCATION_FOOTER.length)}${TRUNCATION_FOOTER}` }]
}

/**
 * Resolve one caller reference to a source and identity.
 *
 * @param ctx - context exposing the blogger registry.
 * @param args - the raw tool arguments.
 * @param signal - cancellation signal.
 * @returns the recognizing source and the identity it resolved.
 */
async function resolveBlogger(
  ctx: Context,
  args: { readonly user: string; readonly source?: string },
  signal: AbortSignal,
): Promise<BloggerResolution> {
  if (args.source === undefined) return ctx.bloggers.resolve(args.user, signal)
  const source = ctx.bloggers.require(args.source)
  return { source, ref: await source.resolve(args.user, signal) }
}

/**
 * Resolve a configured root against the calling agent's workspace.
 *
 * @param configured - the configured directory, absolute or relative.
 * @param cwd - the calling session's working directory, when there is one.
 * @returns the absolute directory the tools read and write.
 */
export function resolveRoot(configured: string, cwd: string | undefined): string {
  if (isAbsolute(configured)) return configured
  return resolvePath(cwd ?? process.cwd(), configured)
}

/**
 * Build the corpus store for one call. The configured root is resolved against
 * the calling session's workspace, so one deployment serves every workspace it
 * runs in.
 *
 * @param ctx - context exposing the filesystem service.
 * @param options - the configured roots and model route.
 * @param limits - the configured corpus bounds.
 * @param cwd - the calling session's working directory, when there is one.
 * @returns the corpus store for this call.
 */
function storeFor(
  ctx: Context,
  options: BloggerToolOptions,
  limits: BloggerToolLimits,
  cwd: string | undefined,
): BloggerCorpusStore {
  return new BloggerCorpusStore(ctx, resolveRoot(options.corpusRoot, cwd), limits)
}

/**
 * Bind the stored bodies to a freshly listed page of post summaries.
 *
 * @param summaries - the listed summaries, newest first.
 * @param stored - the corpus already on disk, when one exists.
 * @returns the summaries carrying whatever body is already stored.
 */
function toCorpusPosts(summaries: readonly BloggerPostSummary[], stored: BloggerCorpus | undefined): CorpusPost[] {
  const bodies = new Map((stored?.posts ?? []).map(post => [post.id, post.bodyMarkdown]))
  return summaries.map((summary) => {
    const body = bodies.get(summary.id)
    return body === undefined
      ? { ...summary, origin: 'platform' }
      : { ...summary, bodyMarkdown: body, origin: 'platform' }
  })
}

/**
 * Count how many of this harvest's ids the stored corpus did not already hold.
 *
 * @param stored - the previously stored ids.
 * @param harvested - this harvest's ids.
 * @returns the count of ids new to the corpus.
 */
function countNew(stored: ReadonlySet<string>, harvested: readonly { readonly id: string }[]): number {
  return harvested.filter(item => !stored.has(item.id)).length
}

/**
 * Register both blogger tools on the context's tool registry.
 *
 * @param ctx - context whose `tools` registry receives the registrations.
 * @param options - the configured roots and model route.
 * @param limits - the configured collection, output, and distillation bounds.
 */
export function applyBloggerTools(ctx: Context, options: BloggerToolOptions, limits: BloggerToolLimits): void {
  ctx.bloggers.register(LOCAL_SOURCE)
  ctx.tools.register(defineTool({
    name: 'blogger_ingest_documents',
    description: 'Fold local markdown documents into a blogger\'s corpus. Use it for material the platform deleted or never carried: pass the same user as blogger_harvest to add documents to a platform blogger, or a reference beginning with local: for a blogger with no platform history. A platform blogger\'s history still comes from blogger_harvest, and both tools write the same corpus, so collect the platform history as well whenever the blogger has one. Each document is markdown with optional YAML frontmatter naming title, publishedAt, kind, platformId, topicTitle, and topicUrl. Re-ingesting a document replaces its record instead of duplicating it.',
    parameters: {
      user: {
        type: 'string',
        required: true,
        description: 'The blogger\'s id or profile page URL on the platform, or a reference such as local:炒股养家 for a blogger with no platform history.',
      },
      source: {
        type: 'string',
        description: 'Source id, when the reference alone does not select one. Omit to let the reference select its own source.',
      },
      userName: {
        type: 'string',
        description: 'Display name to store for a blogger the source does not name, such as a blogger reached through a local: reference.',
      },
      documents: {
        type: 'array',
        required: true,
        description: 'Paths to the markdown documents to read and fold into the corpus.',
        items: { type: 'string' },
      },
      kind: {
        type: 'string',
        description: 'What a document whose frontmatter names no kind is: post or reply. Defaults to post.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          userID: { type: 'string', required: true },
          userName: { type: 'string' },
          corpusPath: { type: 'string', required: true },
          documentsRead: { type: 'integer', required: true },
          postsIngested: { type: 'integer', required: true },
          repliesIngested: { type: 'integer', required: true },
          posts: { type: 'integer', required: true },
          replies: { type: 'integer', required: true },
          offlinePosts: { type: 'integer', required: true },
          offlineReplies: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => boundedText(formatIngest(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const resolution = await resolveBlogger(ctx, args, exec.signal)
      const cwd = exec.agent?.session.header.cwd
      const store = storeFor(ctx, options, limits, cwd)
      const stored = await store.read(resolution.ref.source, resolution.ref.userID, exec.signal)
      const posts: CorpusPost[] = []
      const replies: CorpusReply[] = []
      for (const path of args.documents) {
        const target = await ctx.fs.resolve(resolveRoot(path, cwd), { signal: exec.signal })
        const text = await ctx.fs.readText(target, exec.signal)
        const document = parseDocument(path, text, args.kind === 'reply' ? 'reply' : 'post')
        if (document.kind === 'post') posts.push(documentPost(document))
        else replies.push(documentReply(document))
      }
      const userName = args.userName ?? resolution.ref.userName
      const corpus = await store.ingest(stored, {
        source: resolution.ref.source,
        userID: resolution.ref.userID,
        updatedAt: new Date().toISOString(),
        ...userName === undefined ? {} : { userName },
        posts,
        replies,
      }, exec.signal)
      return {
        source: corpus.source,
        userID: corpus.userID,
        ...corpus.userName === undefined ? {} : { userName: corpus.userName },
        corpusPath: store.pathFor(corpus.source, corpus.userID),
        documentsRead: args.documents.length,
        postsIngested: posts.length,
        repliesIngested: replies.length,
        posts: corpus.posts.length,
        replies: corpus.replies.length,
        offlinePosts: corpus.posts.filter(post => post.origin === 'offline').length,
        offlineReplies: corpus.replies.filter(reply => reply.origin === 'offline').length,
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'blogger_harvest',
    description: 'Harvest a platform blogger\'s posts and replies into a local corpus. Pass the blogger\'s id or profile page URL; each call reads one page window, so pass the returned next page to continue past it.',
    parameters: {
      user: {
        type: 'string',
        required: true,
        description: 'The blogger\'s numeric id or their profile page URL on the platform, for example 905478 or https://www.tgb.cn/blog/905478.',
      },
      source: {
        type: 'string',
        description: 'Platform source id, when the reference alone does not select one. Omit to let the reference select its own platform.',
      },
      postStartPage: { type: 'integer', description: 'The 1-based post page to start from. Defaults to 1; pass the previous call\'s nextPostPage to continue.' },
      postPages: { type: 'integer', description: 'How many pages of the blogger\'s posts to collect this call. Defaults to the configured budget.' },
      replyStartPage: { type: 'integer', description: 'The 1-based reply page to start from. Defaults to 1; pass the previous call\'s nextReplyPage to continue.' },
      replyPages: { type: 'integer', description: 'How many pages of the blogger\'s replies to collect this call. Defaults to the configured budget.' },
      maxPosts: { type: 'integer', description: 'How many post bodies to fetch this call. Defaults to the configured budget.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          userID: { type: 'string', required: true },
          userName: { type: 'string' },
          profileUrl: { type: 'string' },
          corpusPath: { type: 'string', required: true },
          posts: { type: 'integer', required: true },
          postsWithBody: { type: 'integer', required: true },
          replies: { type: 'integer', required: true },
          newPosts: { type: 'integer', required: true },
          newReplies: { type: 'integer', required: true },
          postStartPage: { type: 'integer', required: true },
          postPagesFetched: { type: 'integer', required: true },
          postHasMore: { type: 'boolean', required: true },
          nextPostPage: { type: 'integer' },
          replyStartPage: { type: 'integer', required: true },
          replyPagesFetched: { type: 'integer', required: true },
          replyHasMore: { type: 'boolean', required: true },
          nextReplyPage: { type: 'integer' },
        },
      },
      render: (_args, value) => boundedText(formatHarvest(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { source, ref } = await resolveBlogger(ctx, args, exec.signal)
      const store = storeFor(ctx, options, limits, exec.agent?.session.header.cwd)
      const stored = await store.read(source.id, ref.userID, exec.signal)

      const postStartPage = resolveStartPage(args.postStartPage, 'postStartPage')
      const replyStartPage = resolveStartPage(args.replyStartPage, 'replyStartPage')
      const postPages = resolvePages(args.postPages, limits.maxPostPages, 'postPages')
      const replyPages = resolvePages(args.replyPages, limits.maxReplyPages, 'replyPages')
      const maxPosts = resolvePages(args.maxPosts, limits.maxPosts, 'maxPosts')

      const listed = await source.listPosts(ref, { pageNo: postStartPage, maxPages: postPages, signal: exec.signal })
      const harvested = await fetchBodies(source, ref, toCorpusPosts(listed.items, stored), maxPosts, exec.signal)
      const replies = await source.listReplies(ref, { pageNo: replyStartPage, maxPages: replyPages, signal: exec.signal })

      const harvestedCorpus: HarvestedCorpus = {
        source: source.id,
        userID: ref.userID,
        updatedAt: new Date().toISOString(),
        postStartPage,
        replyStartPage,
        ...ref.userName === undefined ? {} : { userName: ref.userName },
        ...ref.profileUrl === undefined ? {} : { profileUrl: ref.profileUrl },
        posts: harvested,
        replies: replies.items.map(reply => ({ ...reply, origin: 'platform' })),
      }
      const corpus = await store.merge(stored, harvestedCorpus, exec.signal)
      const value: HarvestValue = {
        source: corpus.source,
        userID: corpus.userID,
        ...corpus.userName === undefined ? {} : { userName: corpus.userName },
        ...corpus.profileUrl === undefined ? {} : { profileUrl: corpus.profileUrl },
        corpusPath: store.pathFor(corpus.source, corpus.userID),
        posts: corpus.posts.length,
        postsWithBody: corpus.posts.filter(post => post.bodyMarkdown !== undefined).length,
        replies: corpus.replies.length,
        newPosts: countNew(new Set((stored?.posts ?? []).map(post => post.id)), harvested),
        newReplies: countNew(new Set((stored?.replies ?? []).map(reply => reply.id)), replies.items),
        postStartPage,
        postPagesFetched: listed.pagesFetched,
        postHasMore: listed.hasMore,
        ...listed.hasMore ? { nextPostPage: postStartPage + listed.pagesFetched } : {},
        replyStartPage,
        replyPagesFetched: replies.pagesFetched,
        replyHasMore: replies.hasMore,
        ...replies.hasMore ? { nextReplyPage: replyStartPage + replies.pagesFetched } : {},
      }
      return value
    },
    presentCall: args => ({ card: 'generic', title: `harvest blogger ${args.user}`, kind: 'fetch' }),
  }))

  ctx.tools.register(defineTool({
    name: 'blogger_build_skill',
    description: 'Turn a harvested blogger corpus into a loadable skill: reads the corpus, writes an operating procedure this trader can follow as SKILL.md, and writes the evidence portrait behind its rules beside it. Run blogger_harvest first.',
    parameters: {
      user: {
        type: 'string',
        required: true,
        description: 'The same blogger id or profile page URL passed to blogger_harvest.',
      },
      source: {
        type: 'string',
        description: 'Platform source id, when the reference alone does not select one. Omit to let the reference select its own platform.',
      },
      skillName: {
        type: 'string',
        description: 'Override the generated skill name; lower-case kebab-case. Omit to use the name the model proposes.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          userID: { type: 'string', required: true },
          userName: { type: 'string' },
          skillName: { type: 'string', required: true },
          skillPath: { type: 'string', required: true },
          portraitPath: { type: 'string', required: true },
          description: { type: 'string', required: true },
          posts: { type: 'integer', required: true },
          postsWithBody: { type: 'integer', required: true },
          replies: { type: 'integer', required: true },
          evidenceChars: { type: 'integer', required: true },
          passes: { type: 'integer', required: true },
          notesReused: { type: 'integer', required: true },
          notesPath: { type: 'string', required: true },
        },
      },
      render: (_args, value) => boundedText(formatBuildSkill(value), limits.maxOutputChars),
    },
    timeoutMs: limits.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { source, ref } = await resolveBlogger(ctx, args, exec.signal)
      const store = storeFor(ctx, options, limits, exec.agent?.session.header.cwd)
      const corpus = await store.read(source.id, ref.userID, exec.signal)
      if (corpus === undefined) {
        throw new BloggerSkillError(
          `no harvested corpus for ${source.displayName} user ${ref.userID}; call blogger_harvest first`,
          BLOGGER_CORPUS_MISSING,
        )
      }
      if (corpus.posts.length === 0 && corpus.replies.length === 0) {
        throw new BloggerSkillError(
          `the harvested corpus for ${source.displayName} user ${ref.userID} holds no posts or replies to distill`,
          BLOGGER_CORPUS_EMPTY,
        )
      }
      if (args.skillName !== undefined && !isSkillName(args.skillName)) {
        throw new BloggerSkillError(
          `"${args.skillName}" is not a lower-case kebab-case skill name`,
          BLOGGER_PROFILE_INVALID,
        )
      }
      const session = exec.agent?.session
      const cwd = exec.agent?.session.header.cwd
      const route: ModelRoute = resolveRoute(options.route, session)
      const notesRoot = join(resolveRoot(options.corpusRoot, cwd), 'notes')
      const outcome = await distillProfile(ctx, limits, { corpus, route, session, notesRoot, signal: exec.signal })
      const profile = args.skillName === undefined ? outcome.profile : { ...outcome.profile, name: args.skillName }
      const skillsRoot = resolveRoot(options.skillsRoot, cwd)
      const written = await writeSkillFile(
        ctx, skillsRoot, skillDirectory(profile.name, corpus.userName), profile, exec.signal,
      )
      const value: BuildSkillValue = {
        source: corpus.source,
        userID: corpus.userID,
        ...corpus.userName === undefined ? {} : { userName: corpus.userName },
        skillName: profile.name,
        skillPath: written.skillPath,
        portraitPath: written.portraitPath,
        description: profile.description,
        posts: corpus.posts.length,
        postsWithBody: corpus.posts.filter(post => post.bodyMarkdown !== undefined).length,
        replies: corpus.replies.length,
        evidenceChars: outcome.evidenceChars,
        passes: outcome.passes,
        notesReused: outcome.notesReused,
        notesPath: join(notesRoot, `${corpus.source}-${corpus.userID}`),
      }
      return value
    },
    presentCall: args => ({ card: 'generic', title: `build skill for blogger ${args.user}`, kind: 'edit' }),
  }))
}

/**
 * Fetch the bodies of the listed posts that still lack one, up to the budget.
 *
 * @param source - the resolved source.
 * @param ref - the resolved identity.
 * @param posts - the listed posts carrying any already-stored body.
 * @param maxPosts - the number of bodies this call may fetch.
 * @param signal - cancellation signal.
 * @returns the posts in list order, with newly fetched bodies merged in.
 */
async function fetchBodies(
  source: BloggerResolution['source'],
  ref: BloggerRef,
  posts: readonly CorpusPost[],
  maxPosts: number,
  signal: AbortSignal,
): Promise<CorpusPost[]> {
  const complete: CorpusPost[] = []
  let fetched = 0
  for (const post of posts) {
    if (post.bodyMarkdown !== undefined || fetched >= maxPosts) {
      complete.push(post)
      continue
    }
    const full = await source.fetchPost(ref, post.id, signal)
    complete.push({ ...post, bodyMarkdown: full.bodyMarkdown })
    fetched += 1
  }
  return complete
}

/**
 * Validate and resolve one bounded count argument.
 *
 * @param value - the raw argument, when the model supplied one.
 * @param limit - the configured ceiling.
 * @param name - the argument name, for the failure message.
 * @returns the resolved count.
 */
function resolvePages(value: number | undefined, limit: number, name: string): number {
  const resolved = value ?? limit
  if (resolved < 1) throw new Error(`${name} must be a positive integer`)
  if (resolved > limit) throw new Error(`${name} must be at most ${limit}`)
  return resolved
}

/**
 * Validate one start-page argument. Any page at or beyond the first is legal:
 * the platform decides where a list ends, and a start past its end reads as an
 * empty page.
 *
 * @param value - the raw argument, when the model supplied one.
 * @param name - the argument name, for the failure message.
 * @returns the resolved 1-based start page.
 */
function resolveStartPage(value: number | undefined, name: string): number {
  const resolved = value ?? 1
  if (resolved < 1) throw new Error(`${name} must be a positive integer`)
  return resolved
}

/**
 * Format the harvest result as one markdown block.
 *
 * @param value - the canonical output value.
 * @returns the rendered text.
 */
function formatHarvest(value: HarvestValue): string {
  const posts = `post page(s) ${value.postStartPage}–${value.postStartPage + value.postPagesFetched - 1}`
  const replies = `reply page(s) ${value.replyStartPage}–${value.replyStartPage + value.replyPagesFetched - 1}`
  const next = [
    ...value.nextPostPage === undefined ? [] : [`postStartPage: ${value.nextPostPage}`],
    ...value.nextReplyPage === undefined ? [] : [`replyStartPage: ${value.nextReplyPage}`],
  ]
  return [
    `Harvested ${value.source} blogger ${value.userID}${value.userName === undefined ? '' : ` (${value.userName})`} — `
    + `主贴 ${value.posts}（正文 ${value.postsWithBody}）· 跟帖 ${value.replies}.`,
    `This call added ${value.newPosts} posts and ${value.newReplies} replies; fetched ${posts}`
    + `${value.postHasMore ? '' : ' (no more posts)'} and ${replies}${value.replyHasMore ? '' : ' (no more replies)'}.`,
    ...next.length === 0 ? [] : [`More remains; call again with ${next.join(' and ')}.`],
    `Corpus: ${value.corpusPath}`,
  ].join('\n')
}

/**
 * Format the build-skill result as one markdown block.
 *
 * @param value - the canonical output value.
 * @returns the rendered text.
 */
function formatBuildSkill(value: BuildSkillValue): string {
  return [
    `Built skill \`${value.skillName}\` from ${value.posts} posts (${value.postsWithBody} with bodies) `
    + `and ${value.replies} replies of ${value.source} blogger ${value.userID}.`,
    `Procedure: ${value.skillPath}`,
    `Evidence: ${value.portraitPath}`,
    `Description: ${value.description}`,
    `Evidence read: ${value.evidenceChars} characters in ${value.passes} model request(s)`
    + `${value.notesReused === 0 ? '' : `, ${value.notesReused} window note(s) reused from ${value.notesPath}`}.`,
  ].join('\n')
}
