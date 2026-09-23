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
 * The distillation instructions. They state the two documents the answer must
 * carry, the evidence each may rest on, and the exact JSON the caller parses: the
 * operating procedure is the product, and the portrait is the evidence a reader
 * consults when they doubt a rule.
 */
export const DISTILL_SYSTEM_PROMPT = [
  'You turn one investor\'s published writing into a skill another trader can follow.',
  'Work only from the supplied corpus: posts and replies that this investor wrote.',
  'Answer with two documents.',

  'The first is `skill`, the operating procedure, and it is the product.',
  'Write it in the imperative: every line tells the reader what to do, check, or refuse.',
  'State each rule as a condition and its action together, so a reader can act without interpreting prose.',
  'Cover, in this order, and omit a section only when the corpus is genuinely silent on it:',
  'when this method applies and when it does not; the decision spine as one short chain;',
  'the judgement rules; execution, meaning entries, additions, reductions, and exits, each with its trigger;',
  'position sizing; refusals and failure modes; and a short pre-trade checklist of answerable questions.',
  'Ground every rule in behaviour repeated across the corpus; drop anything one passage alone supports,',
  'and never invent a rule, a threshold, a number, or a checklist item the corpus does not support.',
  'Leave out biography, praise, narrative, dates, decorative stock names, and quotes kept only because they sound good.',
  'A stock name survives only when the name itself carries the rule.',
  'Keep the whole operating procedure within about 150 lines of markdown, and the checklist within ten items.',

  'The second is `portrait`, the evidence portrait: who this investor is, the worldview behind the method,',
  'the recurring arguments, and the verbatim quotes, dates, and cases that license the rules above.',
  'It is the reference a reader consults when they doubt a rule, so it may be as long as the evidence requires.',

  'Both documents are written in the language the investor writes in, headings included.',
  'Answer with one JSON object and nothing else, using exactly these keys:',
  '{"name": "<lower-case kebab-case skill name>", "description": "<one sentence, at most 500 characters, saying when a reader should load this skill>", "skill": "<operating procedure markdown>", "portrait": "<evidence portrait markdown>"}.',
].join(' ')

/** The response contract restated with the digest so the instruction survives truncation. */
const OUTPUT_CONTRACT =
  'Answer with one JSON object and nothing else: {"name": "<kebab-case>", "description": "<one sentence>", "skill": "<operating procedure markdown>", "portrait": "<evidence portrait markdown>"}'

/** The portrait file written beside `SKILL.md`, holding the evidence behind the rules. */
export const PORTRAIT_FILE = 'portrait.md'

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
  const skill = record['skill']
  const portrait = record['portrait']
  if (typeof name !== 'string' || !isSkillName(name)) {
    throw invalidProfile(`"${String(name)}" is not a lower-case kebab-case skill name`)
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw invalidProfile('the answer carried no "description" string')
  }
  if (typeof skill !== 'string' || skill.trim().length === 0) {
    throw invalidProfile('the answer carried no "skill" string')
  }
  if (typeof portrait !== 'string' || portrait.trim().length === 0) {
    throw invalidProfile('the answer carried no "portrait" string')
  }
  return { name, description: description.trim(), skill: skill.trim(), portrait: portrait.trim() }
}

/**
 * Render the operating procedure as a `SKILL.md` document. The description is
 * JSON-quoted so a colon or quote inside it stays a valid YAML frontmatter
 * scalar, and the pointer to the portrait is package-owned text so the evidence
 * stays reachable however the model wrote the procedure.
 *
 * @param profile - the profile to render.
 * @returns the complete file content.
 */
export function renderSkillFile(profile: BloggerProfile): string {
  return [
    '---',
    `name: ${profile.name}`,
    `description: ${JSON.stringify(profile.description)}`,
    '---',
    '',
    profile.skill,
    '',
    '---',
    '',
    `Evidence, quotes, and cases behind these rules: [\`${PORTRAIT_FILE}\`](${PORTRAIT_FILE}).`,
    '',
  ].join('\n')
}

/**
 * Write one profile as `<skillsRoot>/<name>/SKILL.md` plus its evidence portrait.
 *
 * @param ctx - context exposing the filesystem service.
 * @param skillsRoot - the configured skill root directory.
 * @param profile - the profile to write.
 * @param signal - cancellation signal.
 * @returns the absolute paths written.
 */
export async function writeSkillFile(
  ctx: Context,
  skillsRoot: string,
  profile: BloggerProfile,
  signal: AbortSignal,
): Promise<{ skillPath: string; portraitPath: string }> {
  const directory = join(skillsRoot, profile.name)
  const skillPath = join(directory, 'SKILL.md')
  const portraitPath = join(directory, PORTRAIT_FILE)
  const skillTarget = await ctx.fs.resolve(skillPath, { signal })
  await ctx.fs.writeText(skillTarget, renderSkillFile(profile), undefined, signal)
  const portraitTarget = await ctx.fs.resolve(portraitPath, { signal })
  await ctx.fs.writeText(portraitTarget, `${profile.portrait}\n`, undefined, signal)
  return { skillPath, portraitPath }
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
