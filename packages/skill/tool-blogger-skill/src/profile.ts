/**
 * Distillation of one blogger corpus into a skill: the fixed instructions, the
 * bounded corpus digest, the auxiliary model request (recorded before dispatch),
 * the response grammar, and the `SKILL.md` file it becomes. The request is built
 * by hand rather than by the agent loop, so it carries its own system prompt, is
 * deep-frozen, and is never marked as a loop request.
 * @module @deepseek-ai/dsh-tool-blogger-skill/profile
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BloggerReply } from '@deepseek-ai/dsh-blogger'
import type { FinishReason, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { BLOGGER_DISTILL_ROUTE_UNSET, BLOGGER_PROFILE_INVALID, BloggerSkillError } from './errors.ts'
import type { BloggerCorpus, BloggerProfile, CorpusPost } from './types.ts'

/** The model route one distillation dispatches through. */
export interface ModelRoute {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** Deployment-owned bounds one distillation honors. */
export interface DistillLimits {
  /** Maximum characters in the corpus digest sent as the user message. */
  readonly maxPromptChars: number
  /** Output-token cap for the distillation request. */
  readonly maxOutputTokens: number
}

/** One distillation's subject and cancellation. */
export interface DistillRequest {
  /** The corpus to distill. */
  readonly corpus: BloggerCorpus
  /** The route to dispatch through. */
  readonly route: ModelRoute
  /** The session to record the request in, when the call runs for one. */
  readonly session?: DistillSession | undefined
  /** Cancellation signal. */
  readonly signal: AbortSignal
}

/**
 * The session facts one distillation reads and records into. A `Session`
 * satisfies this; the narrow form keeps the request buildable without one.
 */
export interface DistillSession {
  /** Stable session identity passed to the model request. */
  readonly id: SessionId
  /** Append the log-only request record. */
  append(type: 'blogger/distill-request', data: BloggerDistillRequestEventData): void
  /** The latest durable request target, when the session has one. */
  requestHeader(): { readonly config: { readonly provider: string; readonly model: string } } | undefined
}

/** The distillation outcome plus the facts a caller reports. */
export interface DistillOutcome {
  /** The parsed profile. */
  readonly profile: BloggerProfile
  /** Characters in the rendered corpus digest. */
  readonly digestChars: number
  /** Whether the digest hit `maxPromptChars` before the corpus was exhausted. */
  readonly digestTruncated: boolean
}

/** Exact model-visible request recorded before one blogger distillation dispatch. */
export interface BloggerDistillRequestEventData {
  /** The source id the corpus came from. */
  readonly source: string
  /** The blogger's user id on that source. */
  readonly userID: string
  /** The exact auxiliary LLM route. */
  readonly route: ModelRoute
  /** The exact auxiliary system prompt. */
  readonly system: string
  /** The exact auxiliary message list. */
  readonly messages: RequestMessage[]
  /** The exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one blogger-distillation model request. */
    'blogger/distill-request': BloggerDistillRequestEventData
  }
}

/**
 * The distillation instructions. They state the task, the evidence the answer
 * must rest on, and the exact JSON answer the caller parses.
 */
export const DISTILL_SYSTEM_PROMPT = [
  'You distill one stock-forum blogger\'s published writing into a reusable reasoning profile.',
  'Work only from the supplied corpus: posts and replies that blogger wrote.',
  'Infer the blogger\'s decision rules, the evidence they weigh, the market conditions they trade,',
  'the positions they take, and the recurring mistakes they warn about.',
  'Ground every rule in repeated behaviour across the corpus, not in one post; when the corpus is too',
  'thin to support a rule, omit it rather than inventing one.',
  'Write the profile in the same language the blogger writes in.',
  'Answer with one JSON object and nothing else, using exactly these keys:',
  '{"name": "<lower-case kebab-case skill name>", "description": "<one sentence, at most 500 characters, saying when a reader should consult this profile>", "content": "<the profile as markdown>"}.',
].join(' ')

/** The response contract restated with the digest so the instruction survives truncation. */
const OUTPUT_CONTRACT =
  'Answer with one JSON object and nothing else: {"name": "<kebab-case>", "description": "<one sentence>", "content": "<markdown profile>"}'

/**
 * Resolve the model route for one distillation: the configured pair when both
 * fields are set, otherwise the target the session's latest request was routed to.
 *
 * @param config - the plugin's optional provider/model pair.
 * @param session - the session whose logged request target may be inherited.
 * @returns the resolved route.
 */
export function resolveRoute(
  config: { readonly provider?: string; readonly model?: string },
  session: DistillSession | undefined,
): ModelRoute {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const routed = session?.requestHeader()?.config
  if (routed === undefined) {
    throw new BloggerSkillError(
      'no blogger distillation model is configured and the session has no request target to inherit; set the plugin provider and model',
      BLOGGER_DISTILL_ROUTE_UNSET,
    )
  }
  return { provider: routed.provider, model: routed.model }
}

/**
 * Render the bounded corpus digest.
 *
 * @param corpus - the corpus to render.
 * @param maxChars - the character bound on the rendered digest.
 * @returns the digest and whether it stopped before the corpus was exhausted.
 */
export function renderDigest(corpus: BloggerCorpus, maxChars: number): { digest: string; truncated: boolean } {
  const blocks = [renderHeader(corpus), ...corpus.posts.map(renderPost), ...corpus.replies.map(renderReply)]
  const kept: string[] = []
  let used = 0
  for (const block of blocks) {
    const cost = block.length + (kept.length === 0 ? 0 : 1)
    if (used + cost > maxChars) return { digest: kept.join('\n'), truncated: true }
    kept.push(block)
    used += cost
  }
  return { digest: kept.join('\n'), truncated: false }
}

/**
 * Distill one corpus through `ctx.llm`, recording the exact request before dispatch.
 *
 * @param ctx - context exposing the LLM service.
 * @param limits - the digest and output-token bounds.
 * @param request - the corpus, route, session, and cancellation.
 * @returns the parsed profile and the digest facts.
 */
export async function distillProfile(
  ctx: Context,
  limits: DistillLimits,
  request: DistillRequest,
): Promise<DistillOutcome> {
  const { digest, truncated } = renderDigest(request.corpus, limits.maxPromptChars)
  const messages: RequestMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: `${digest}\n\n${OUTPUT_CONTRACT}` }],
  }]
  const options: GenerateOptions = deepFreeze({
    provider: request.route.provider,
    model: request.route.model,
    messages,
    system: DISTILL_SYSTEM_PROMPT,
    maxTokens: limits.maxOutputTokens,
    ...request.session === undefined ? {} : { sessionId: request.session.id },
    signal: request.signal,
  })
  request.session?.append('blogger/distill-request', {
    source: request.corpus.source,
    userID: request.corpus.userID,
    route: request.route,
    system: DISTILL_SYSTEM_PROMPT,
    messages,
    maxTokens: limits.maxOutputTokens,
  })

  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  assertFinished(assembler.finish)
  const answer = assembler.blocks().map(block => block.type === 'text' ? block.text : '').join('')
  return { profile: parseProfile(answer), digestChars: digest.length, digestTruncated: truncated }
}

/**
 * Parse the distillation answer into one profile.
 *
 * @param answer - the model's complete text answer.
 * @returns the validated profile.
 */
export function parseProfile(answer: string): BloggerProfile {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw invalidProfile('the answer carried no JSON object')
  }
  let value: unknown
  try {
    value = JSON.parse(answer.slice(start, end + 1))
  } catch (error: unknown) {
    throw invalidProfile('the JSON object in the answer did not parse', error)
  }
  // The slice is delimited by the answer's outermost braces, so a successful
  // parse always yields an object; only its fields remain to check.
  const record = value as Record<string, unknown>
  const name = record['name']
  const description = record['description']
  const content = record['content']
  if (typeof name !== 'string' || !isSkillName(name)) {
    throw invalidProfile(`"${String(name)}" is not a lower-case kebab-case skill name`)
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw invalidProfile('the answer carried no "description" string')
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw invalidProfile('the answer carried no "content" string')
  }
  return { name, description: description.trim(), content: content.trim() }
}

/**
 * Render one profile as a `SKILL.md` document. The description is JSON-quoted so
 * a colon or quote inside it stays a valid YAML frontmatter scalar.
 *
 * @param profile - the profile to render.
 * @returns the complete file content.
 */
export function renderSkillFile(profile: BloggerProfile): string {
  return `---\nname: ${profile.name}\ndescription: ${JSON.stringify(profile.description)}\n---\n\n${profile.content}\n`
}

/**
 * Write one profile as `<skillsRoot>/<name>/SKILL.md`.
 *
 * @param ctx - context exposing the filesystem service.
 * @param skillsRoot - the configured skill root directory.
 * @param profile - the profile to write.
 * @param signal - cancellation signal.
 * @returns the absolute path written.
 */
export async function writeSkillFile(
  ctx: Context,
  skillsRoot: string,
  profile: BloggerProfile,
  signal: AbortSignal,
): Promise<string> {
  const path = join(skillsRoot, profile.name, 'SKILL.md')
  const target = await ctx.fs.resolve(path, { signal })
  await ctx.fs.writeText(target, renderSkillFile(profile), undefined, signal)
  return path
}

/**
 * Render the digest header naming the blogger and the collected volume.
 *
 * @param corpus - the corpus to describe.
 * @returns the header block.
 */
function renderHeader(corpus: BloggerCorpus): string {
  const withBody = corpus.posts.filter(post => post.bodyMarkdown !== undefined).length
  return [
    `# 博主 ${corpus.userName ?? corpus.userID}（${corpus.source}）`,
    ...corpus.profileUrl === undefined ? [] : [`主页：${corpus.profileUrl}`],
    `采集范围：主贴 ${corpus.posts.length} 篇（其中 ${withBody} 篇有正文），跟帖 ${corpus.replies.length} 条。`,
  ].join('\n')
}

/**
 * Render one post block.
 *
 * @param post - the post to render.
 * @returns the block.
 */
function renderPost(post: CorpusPost): string {
  return [
    `## ${post.publishedAt} 《${post.title}》`,
    post.url,
    post.bodyMarkdown ?? '(未采集正文)',
  ].join('\n')
}

/**
 * Render one reply block.
 *
 * @param reply - the reply to render.
 * @returns the block.
 */
function renderReply(reply: BloggerReply): string {
  return `- ${reply.repliedAt} ${reply.body} — 来自《${reply.topicTitle}》 ${reply.topicUrl}`
}

/**
 * Translate a terminal finish reason into a distillation failure.
 *
 * @param finish - the assembler's terminal finish reason.
 */
function assertFinished(finish: FinishReason): void {
  switch (finish.kind) {
    case 'stop':
      return
    case 'error':
    case 'aborted':
      throw new BloggerSkillError(`the blogger distillation model failed: ${finish.failure.message}`, finish.failure.code)
    case 'max-tokens':
      throw invalidProfile('the answer reached maxOutputTokens before finishing')
    case 'tool-calls':
      throw invalidProfile('the model requested a tool, but the distillation request offers none')
    default:
      throw invalidProfile(`unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Build one profile-grammar failure.
 *
 * @param detail - what the answer failed to satisfy.
 * @param cause - the parse failure, when one exists.
 * @returns the error to throw.
 */
function invalidProfile(detail: string, cause?: unknown): BloggerSkillError {
  const message = `the blogger distillation answer is not a usable profile: ${detail}`
  return cause === undefined
    ? new BloggerSkillError(message, BLOGGER_PROFILE_INVALID)
    : new BloggerSkillError(message, BLOGGER_PROFILE_INVALID, { cause })
}
