/**
 * Distillation of one blogger corpus into a skill: the fixed instructions, the
 * bounded corpus digest, the auxiliary model request (recorded before dispatch),
 * the response grammar, and the `SKILL.md` file it becomes. The request is built
 * by hand rather than by the agent loop, so it carries its own system prompt, is
 * deep-frozen, and is never marked as a loop request.
 * @module @deepseek-ai/dsh-tool-blogger-skill/profile
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FinishReason, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { chunkBlocks, digestBlocks, estimateTokens } from './chunk.ts'
import type { DigestChunk } from './chunk.ts'
import { BLOGGER_DISTILL_ROUTE_UNSET, BLOGGER_EVIDENCE_TOO_LARGE, BLOGGER_PROFILE_INVALID, BloggerSkillError } from './errors.ts'
import type { BloggerCorpus, BloggerProfile } from './types.ts'

/** The model route one distillation dispatches through. */
export interface ModelRoute {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** Deployment-owned bounds one distillation honors. */
export interface DistillLimits {
  /** Estimated-token budget for one model request; a larger corpus is read in several windows. */
  readonly maxPromptTokens: number
  /** Output-token cap for each model request. */
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
  /** Directory the per-window evidence notes are written under. */
  readonly notesRoot: string
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
  /** Characters of corpus evidence sent across every pass. */
  readonly evidenceChars: number
  /** Model requests this distillation made: one per window, plus the merge. */
  readonly passes: number
  /** Windows whose evidence notes were reused from disk instead of regenerated. */
  readonly notesReused: number
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
 * The line separating the response's JSON header from the operating procedure.
 * Long markdown cannot survive JSON string escaping, so the procedure travels as
 * plain text after this marker and only the short header is JSON.
 */
export const PROCEDURE_MARKER = '<<<DSH:PROCEDURE>>>'

/**
 * The procedure instructions. This is the product, so it is the only document
 * this request asks for: two documents in one answer overran the output-token cap
 * and lost the whole answer.
 */
export const DISTILL_SYSTEM_PROMPT = [
  'You turn one investor\'s published writing into an operating procedure another trader can follow.',
  'Work only from the supplied evidence.',
  'Write the procedure in the imperative: every line tells the reader what to do, check, or refuse.',
  'State each rule as a condition and its action together, so a reader can act without interpreting prose.',
  'Cover, in this order, and omit a section only when the evidence is genuinely silent on it:',
  'when this method applies and when it does not; the decision spine as one short chain;',
  'the judgement rules; execution, meaning entries, additions, reductions, and exits, each with its trigger;',
  'position sizing; refusals and failure modes; and a short pre-trade checklist of answerable questions.',
  'Ground every rule in behaviour repeated across the evidence; drop anything one passage alone supports,',
  'and never invent a rule, a threshold, a number, or a checklist item the evidence does not support.',
  'Leave out biography, praise, narrative, dates, decorative stock names, and quotes kept only because they sound good.',
  'A stock name survives only when the name itself carries the rule.',
  'Keep the whole procedure within about 80 lines of markdown, and the checklist within ten items.',
  'Write it in the language the investor writes in, headings included.',
  'Answer in exactly two parts and nothing else.',
  'First, one JSON object on its own line holding only "name" and "description":',
  'name is a lower-case kebab-case skill name, and description is one sentence of at most 500 characters saying when a reader should load this skill.',
  `Then, on its own line, ${PROCEDURE_MARKER}, followed by the procedure markdown.`,
  'Write the procedure as plain markdown: never wrap it in a code fence, never escape it as a JSON string,',
  'and never repeat the JSON object after the marker.',
].join(' ')

/** The procedure response contract, restated so the instruction survives input truncation. */
const OUTPUT_CONTRACT = [
  'Answer in exactly two parts and nothing else.',
  '{"name": "<kebab-case>", "description": "<one sentence>"}',
  PROCEDURE_MARKER,
  '<operating procedure markdown, no code fence>',
].join('\n')

/**
 * The portrait instructions. It runs as its own request, after the procedure, so
 * the investor it describes is the one the procedure came from, and so neither
 * document competes for one answer's output budget.
 */
export const PORTRAIT_SYSTEM_PROMPT = [
  'You write the portrait of one investor, for a reader who follows the operating procedure distilled from the same writing.',
  'Work only from the supplied evidence; never add a fact or a rule it does not carry.',
  'Describe the investor as a trader: the worldview behind the method, the arguments they return to,',
  'the habits they keep, the mistakes they admit to, and the voice they argue in.',
  'Quote them verbatim where their own words carry the idea, but write prose about the person.',
  'Name no post, no thread, no date, and no source, and never mention how the writing was collected or how much of it there was.',
  'Leave out praise and narrative, and never invent a quote, a fact, or a case.',
  'Write it in the language the investor writes in, headings included, within about 120 lines.',
  'Answer with the portrait markdown and nothing else: no preamble and no code fence.',
].join(' ')

/** The portrait response contract, restated so the instruction survives input truncation. */
const PORTRAIT_CONTRACT = 'Answer with the portrait markdown and nothing else: no preamble and no code fence.'

/** The portrait file written beside `SKILL.md`, describing the investor behind the rules. */
export const PORTRAIT_FILE = 'portrait.md'

/**
 * The evidence-pass instructions: one bounded window of the corpus in, one terse
 * evidence note out. The merge pass reads the notes rather than the corpus, so a
 * note must carry the evidence and nothing that only decorates it.
 */
export const EVIDENCE_SYSTEM_PROMPT = [
  'You read one window of an investor\'s published writing and record the evidence it holds.',
  'This window is one of several; a later pass merges your note with the others.',
  'Write a terse evidence note in markdown, in the language the investor writes in.',
  'Record the rules this window states or follows, and for each one the verbatim quote,',
  'the date, and the case that carries it. State a rule once, then list the passages supporting it.',
  'Record nothing else: no summary of the writer, no praise, no restating of the corpus,',
  'no speculation beyond the window, and nothing the window does not say.',
  'Keep the note within about 80 lines.',
  'Answer with the note markdown and nothing else: no preamble and no code fence.',
].join(' ')

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
 * Distill one corpus into a skill. A corpus that fits the request budget is read
 * in one pass; a larger one is read window by window, each window writing an
 * evidence note, and one merge pass turns the notes into the skill. Every request
 * is therefore bounded however large the corpus grows, and a note already on disk
 * for an unchanged window is reused instead of regenerated.
 *
 * @param ctx - context exposing the LLM and filesystem services.
 * @param limits - the request and output-token bounds.
 * @param request - the corpus, route, session, notes directory, and cancellation.
 * @returns the parsed profile and the pass facts.
 */
export async function distillProfile(
  ctx: Context,
  limits: DistillLimits,
  request: DistillRequest,
): Promise<DistillOutcome> {
  const chunks = chunkBlocks(digestBlocks(request.corpus, limits.maxPromptTokens), limits.maxPromptTokens)
  const evidenceChars = chunks.reduce((total, chunk) => total + chunk.text.length, 0)
  const single = chunks.length === 1 ? chunks[0] : undefined
  const notes: string[] = []
  let passes = 0
  let notesReused = 0
  if (single !== undefined) {
    notes.push(single.text)
  } else {
    for (const chunk of chunks) {
      const stored = await readNote(ctx, request, chunk)
      if (stored !== undefined) {
        notes.push(stored)
        notesReused += 1
        continue
      }
      const note = await callModel(
        ctx, limits, request, EVIDENCE_SYSTEM_PROMPT,
        evidenceUserMessage(chunk, chunks.length),
        `evidence pass for window ${chunk.index} of ${chunks.length}`,
      )
      passes += 1
      await writeNote(ctx, request, chunk, note)
      notes.push(note)
    }
  }
  const merge = mergeUserMessage(notes, single === undefined)
  if (estimateTokens(merge) > limits.maxPromptTokens) {
    throw new BloggerSkillError(
      `the ${chunks.length} evidence notes exceed the ${limits.maxPromptTokens}-token merge budget; raise maxPromptTokens or narrow the harvest`,
      BLOGGER_EVIDENCE_TOO_LARGE,
    )
  }
  const procedure = parseProcedure(await callModel(ctx, limits, request, DISTILL_SYSTEM_PROMPT, merge, 'procedure pass'))
  const portraitPrompt = `${merge}\n\n--- operating procedure ---\n\n${procedure.skill}\n\n${PORTRAIT_CONTRACT}`
  if (estimateTokens(portraitPrompt) > limits.maxPromptTokens) {
    throw new BloggerSkillError(
      `the evidence notes and the procedure exceed the ${limits.maxPromptTokens}-token portrait budget; raise maxPromptTokens or narrow the harvest`,
      BLOGGER_EVIDENCE_TOO_LARGE,
    )
  }
  const portrait = parsePortrait(await callModel(ctx, limits, request, PORTRAIT_SYSTEM_PROMPT, portraitPrompt, 'portrait pass'))
  return { profile: { ...procedure, portrait }, evidenceChars, passes: passes + 2, notesReused }
}

/**
 * Run one recorded model request and return its visible text. The request is
 * hand-built rather than loop-built, so it carries its own system prompt, is
 * deep-frozen, is never marked as a loop request, and is logged before dispatch.
 *
 * @param ctx - context exposing the LLM service.
 * @param limits - the output-token bound.
 * @param request - the route, session, and cancellation.
 * @param system - the exact system prompt.
 * @param userText - the exact user message.
 * @param pass - which pass this request is, named in any failure it reports.
 * @returns the answer's visible text.
 */
async function callModel(
  ctx: Context,
  limits: DistillLimits,
  request: DistillRequest,
  system: string,
  userText: string,
  pass: string,
): Promise<string> {
  const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
  const options: GenerateOptions = deepFreeze({
    provider: request.route.provider,
    model: request.route.model,
    messages,
    system,
    maxTokens: limits.maxOutputTokens,
    ...request.session === undefined ? {} : { sessionId: request.session.id },
    signal: request.signal,
  })
  request.session?.append('blogger/distill-request', {
    source: request.corpus.source,
    userID: request.corpus.userID,
    route: request.route,
    system,
    messages,
    maxTokens: limits.maxOutputTokens,
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  assertFinished(assembler.finish, pass)
  return assembler.blocks().map(block => block.type === 'text' ? block.text : '').join('')
}

/**
 * The path one window's evidence note occupies. The window's content hash is part
 * of the name, so a note is reused only while its window is unchanged.
 *
 * @param request - the distillation request owning the notes directory.
 * @param chunk - the window the note documents.
 * @returns the absolute note path.
 */
function notePath(request: DistillRequest, chunk: DigestChunk): string {
  const hash = createHash('sha256').update(chunk.text).digest('hex').slice(0, 16)
  return join(request.notesRoot, `${request.corpus.source}-${request.corpus.userID}`, `${chunk.index}-${hash}.md`)
}

/**
 * Read one window's stored evidence note.
 *
 * @param ctx - context exposing the filesystem service.
 * @param request - the distillation request owning the notes directory.
 * @param chunk - the window the note documents.
 * @returns the stored note, or `undefined` when none exists or it is empty.
 */
async function readNote(ctx: Context, request: DistillRequest, chunk: DigestChunk): Promise<string | undefined> {
  const target = await ctx.fs.resolve(notePath(request, chunk), { signal: request.signal })
  if (await ctx.fs.stat(target, request.signal) === undefined) return undefined
  const stored = (await ctx.fs.readText(target, request.signal)).trim()
  return stored.length === 0 ? undefined : stored
}

/**
 * Write one window's evidence note.
 *
 * @param ctx - context exposing the filesystem service.
 * @param request - the distillation request owning the notes directory.
 * @param chunk - the window the note documents.
 * @param note - the note's markdown.
 */
async function writeNote(ctx: Context, request: DistillRequest, chunk: DigestChunk, note: string): Promise<void> {
  const target = await ctx.fs.resolve(notePath(request, chunk), { signal: request.signal })
  await ctx.fs.writeText(target, `${note.trim()}\n`, undefined, request.signal)
}

/**
 * Frame one window for the evidence pass.
 *
 * @param chunk - the window to read.
 * @param total - how many windows the corpus was split into.
 * @returns the exact user message.
 */
function evidenceUserMessage(chunk: DigestChunk, total: number): string {
  return [
    `This is window ${chunk.index} of ${total} of the corpus.`,
    '',
    chunk.text,
    '',
    'Write the evidence note for this window.',
  ].join('\n')
}

/**
 * Frame the merged evidence for the final pass.
 *
 * @param notes - the evidence notes, or the whole corpus when there is one window.
 * @param fromNotes - whether the text is window notes rather than the raw corpus.
 * @returns the exact user message, carrying the response contract.
 */
function mergeUserMessage(notes: readonly string[], fromNotes: boolean): string {
  const framing = fromNotes
    ? `The ${notes.length} evidence notes below were distilled from the full corpus, window by window. Work only from them.`
    : 'The full corpus is below. Work only from it.'
  const body = fromNotes
    ? notes.map((note, index) => `--- note ${index + 1} ---\n${note}`).join('\n\n')
    : notes.join('\n\n')
  return `${framing}\n\n${body}\n\n${OUTPUT_CONTRACT}`
}

/**
 * Parse the procedure answer: a short JSON header holding the name and
 * description, then the procedure as plain markdown after {@link PROCEDURE_MARKER}.
 * Only the header is JSON, because the procedure is far too long to survive JSON
 * string escaping.
 *
 * @param answer - the model's complete text answer.
 * @returns the validated name, description, and procedure.
 */
export function parseProcedure(answer: string): Omit<BloggerProfile, 'portrait'> {
  const header = parseHeader(answer)
  const procedureAt = answer.indexOf(PROCEDURE_MARKER, header.end)
  if (procedureAt === -1) {
    throw invalidProfile(`the answer carried no ${PROCEDURE_MARKER} line`, answer)
  }
  const skill = unfence(answer.slice(procedureAt + PROCEDURE_MARKER.length))
  if (skill.length === 0) throw invalidProfile('the answer carried an empty operating procedure', answer)
  return { name: header.name, description: header.description, skill }
}

/**
 * Parse the portrait answer, which is the whole response as plain markdown.
 *
 * @param answer - the model's complete text answer.
 * @returns the portrait markdown.
 */
export function parsePortrait(answer: string): string {
  const portrait = unfence(answer)
  if (portrait.length === 0) throw invalidProfile('the answer carried an empty evidence portrait', answer)
  return portrait
}

/**
 * Parse the answer's leading JSON header.
 *
 * @param answer - the model's complete text answer.
 * @returns the validated name and description, with the header's end offset.
 */
function parseHeader(answer: string): { name: string; description: string; end: number } {
  // Tolerate a lead-in line ("Here it is:") before the header, but not a missing
  // or unterminated one: the header is the answer's first object.
  const start = answer.indexOf('{')
  const end = start === -1 ? -1 : answer.indexOf('}', start)
  if (end === -1) {
    throw invalidProfile('the answer did not begin with the JSON header object', answer)
  }
  let value: unknown
  try {
    value = JSON.parse(answer.slice(start, end + 1))
  } catch (error: unknown) {
    throw invalidProfile('the answer\'s JSON header did not parse', answer, error)
  }
  // The slice is delimited by the leading brace and the first closing brace, so a
  // successful parse always yields an object; only its fields remain to check.
  const record = value as Record<string, unknown>
  const name = record['name']
  const description = record['description']
  if (typeof name !== 'string' || !isSkillName(name)) {
    throw invalidProfile(`"${String(name)}" is not a lower-case kebab-case skill name`, answer)
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw invalidProfile('the header carried no "description" string', answer)
  }
  return { name, description: description.trim(), end: end + 1 }
}

/**
 * Strip one optional surrounding code fence from a document section.
 *
 * @param section - the raw section text.
 * @returns the trimmed markdown, without a fence the model added anyway.
 */
function unfence(section: string): string {
  const trimmed = section.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
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
    `The investor behind these rules: [\`${PORTRAIT_FILE}\`](${PORTRAIT_FILE}).`,
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
 * Translate a terminal finish reason into a distillation failure.
 *
 * @param finish - the assembler's terminal finish reason.
 * @param pass - which pass the request was, named in the failure.
 */
function assertFinished(finish: FinishReason, pass: string): void {
  switch (finish.kind) {
    case 'stop':
      return
    case 'error':
    case 'aborted':
      throw new BloggerSkillError(
        `the ${pass} failed: ${finish.failure.message}`,
        finish.failure.code,
      )
    case 'max-tokens':
      throw invalidProfile(`the ${pass} reached maxOutputTokens before finishing`)
    case 'tool-calls':
      throw invalidProfile(`the ${pass} requested a tool, but the distillation request offers none`)
    default:
      throw invalidProfile(`the ${pass} ended with unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Build one profile-grammar failure. A parse failure carries an excerpt of the
 * answer so the model can see what it actually wrote instead of guessing.
 *
 * @param detail - what the answer failed to satisfy.
 * @param answer - the model's answer, when the failure was about its content.
 * @param cause - the parse failure, when one exists.
 * @returns the error to throw.
 */
function invalidProfile(detail: string, answer?: string, cause?: unknown): BloggerSkillError {
  const excerpt = answer === undefined ? '' : `; the answer began: "${answer.trim().replace(/\s+/gu, ' ').slice(0, 300)}"`
  const message = `the blogger distillation answer is not a usable profile: ${detail}${excerpt}`
  return cause === undefined
    ? new BloggerSkillError(message, BLOGGER_PROFILE_INVALID)
    : new BloggerSkillError(message, BLOGGER_PROFILE_INVALID, { cause })
}
