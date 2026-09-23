/**
 * Plugin entry for the blogger-skill tools. It resolves every deployment bound
 * from its config and registers `blogger_harvest` and `blogger_build_skill`,
 * which read a platform blogger through `ctx.bloggers`, store the corpus under
 * `ctx.fs`, distill it through `ctx.llm`, and write the resulting `SKILL.md`
 * where the skill provider scans.
 * @module @deepseek-ai/dsh-tool-blogger-skill
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BLOGGER_CONFIG_INVALID, BloggerSkillError } from './errors.ts'
import { applyBloggerTools } from './tools.ts'

export {
  BLOGGER_CONFIG_INVALID,
  BLOGGER_CORPUS_EMPTY,
  BLOGGER_CORPUS_INVALID,
  BLOGGER_CORPUS_MISSING,
  BLOGGER_DISTILL_ROUTE_UNSET,
  BLOGGER_EVIDENCE_TOO_LARGE,
  BLOGGER_PROFILE_INVALID,
  BloggerSkillError,
} from './errors.ts'
export { applyBloggerTools } from './tools.ts'
export type { BuildSkillValue, BloggerToolLimits, BloggerToolOptions, HarvestValue } from './tools.ts'
export { chunkBlocks, digestBlocks, estimateTokens } from './chunk.ts'
export type { DigestBlock, DigestChunk } from './chunk.ts'
export { EVIDENCE_MARKER, PROCEDURE_MARKER } from './profile.ts'
export { parseCorpus, serializeCorpus } from './corpus.ts'
export type { BloggerCorpus, BloggerProfile, CorpusPost } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-blogger-skill'

/** Services the blogger tools read from. */
export const inject = ['tools', 'bloggers', 'llm', 'fs']

/** Default directory, relative to the session workspace, the skill files are written under. */
export const DEFAULT_SKILLS_ROOT = '.dsh/skills'

/** Default directory, relative to the session workspace, the corpora are stored under. */
export const DEFAULT_CORPUS_ROOT = '.dsh/bloggers'

/** Default page budget for one harvest's post collection. */
export const DEFAULT_MAX_POST_PAGES = 3

/** Default page budget for one harvest's reply collection. */
export const DEFAULT_MAX_REPLY_PAGES = 3

/** Default number of post bodies one harvest fetches. */
export const DEFAULT_MAX_POSTS = 20

/** Default retained-post bound for one corpus. */
export const DEFAULT_MAX_CORPUS_POSTS = 300

/** Default retained-reply bound for one corpus. */
export const DEFAULT_MAX_CORPUS_REPLIES = 600

/** Default estimated-token budget for one distillation request. */
export const DEFAULT_MAX_PROMPT_TOKENS = 60_000

/** Default output-token cap for the distillation request. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000

/** Default cap on one complete rendered tool output (characters). */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000

/** Default cooperative tool-call timeout budget (ms). */
export const DEFAULT_TIMEOUT_MS = 600_000

/** Plugin config: the storage roots, the optional model route, and every deployment bound. */
export interface Config {
  /** Directory the skill files are written under; relative paths resolve against the session workspace. Defaults to `.dsh/skills`. */
  readonly skillsRoot?: string
  /** Directory the corpora are stored under; relative paths resolve against the session workspace. Defaults to `.dsh/bloggers`. */
  readonly corpusRoot?: string
  /** Distillation provider route. Set together with `model`; omit both to inherit the session's request target. */
  readonly provider?: string
  /** Distillation model id. Set together with `provider`; omit both to inherit the session's request target. */
  readonly model?: string
  /** Page budget for one harvest's post collection; the tools reject larger `postPages`. Defaults to 3. */
  readonly maxPostPages?: number
  /** Page budget for one harvest's reply collection; the tools reject larger `replyPages`. Defaults to 3. */
  readonly maxReplyPages?: number
  /** Post bodies one harvest may fetch; the tools reject a larger `maxPosts`. Defaults to 20. */
  readonly maxPosts?: number
  /** Maximum posts one corpus retains. Defaults to 300. */
  readonly maxCorpusPosts?: number
  /** Maximum replies one corpus retains. Defaults to 600. */
  readonly maxCorpusReplies?: number
  /** Estimated-token budget for one distillation request; a corpus beyond it is read window by window. Defaults to 60000. */
  readonly maxPromptTokens?: number
  /** Output-token cap for the distillation request. Defaults to 16000. */
  readonly maxOutputTokens?: number
  /** Cap on one complete rendered tool output in characters. Defaults to 20000. */
  readonly maxOutputChars?: number
  /** Cooperative tool-call timeout budget (ms). Defaults to 600000. */
  readonly timeoutMs?: number
}

export const Config: z<Config> = z.object({
  skillsRoot: z.string().default(DEFAULT_SKILLS_ROOT),
  corpusRoot: z.string().default(DEFAULT_CORPUS_ROOT),
  provider: z.string(),
  model: z.string(),
  maxPostPages: z.number().step(1).min(1).max(50).default(DEFAULT_MAX_POST_PAGES),
  maxReplyPages: z.number().step(1).min(1).max(50).default(DEFAULT_MAX_REPLY_PAGES),
  maxPosts: z.number().step(1).min(1).max(1000).default(DEFAULT_MAX_POSTS),
  maxCorpusPosts: z.number().step(1).min(1).max(100_000).default(DEFAULT_MAX_CORPUS_POSTS),
  maxCorpusReplies: z.number().step(1).min(1).max(100_000).default(DEFAULT_MAX_CORPUS_REPLIES),
  maxPromptTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_PROMPT_TOKENS),
  maxOutputTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_OUTPUT_TOKENS),
  maxOutputChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_OUTPUT_CHARS),
  timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Register the blogger tools. The schema enforces every numeric bound at load;
 * the provider/model pairing is the one load-time fact the schema cannot
 * express, so it is checked here, fail-loud.
 *
 * @param ctx - context whose `tools` registry receives the two registrations.
 * @param config - the resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  const route = resolveConfiguredRoute(config)
  applyBloggerTools(ctx, {
    skillsRoot: resolved.skillsRoot,
    corpusRoot: resolved.corpusRoot,
    route,
  }, {
    maxPostPages: resolved.maxPostPages,
    maxReplyPages: resolved.maxReplyPages,
    maxPosts: resolved.maxPosts,
    maxCorpusPosts: resolved.maxCorpusPosts,
    maxCorpusReplies: resolved.maxCorpusReplies,
    maxPromptTokens: resolved.maxPromptTokens,
    maxOutputTokens: resolved.maxOutputTokens,
    maxOutputChars: resolved.maxOutputChars,
    timeoutMs: resolved.timeoutMs,
  })
}

/**
 * Require the configured distillation route to name both halves or neither.
 *
 * @param config - the plugin config as the Loader supplied it, before defaults.
 * @returns the configured route, or an empty object when the session target is inherited.
 */
function resolveConfiguredRoute(config: Config): { provider?: string; model?: string } {
  if (config.provider === undefined && config.model === undefined) return {}
  if (config.provider === undefined || config.model === undefined) {
    throw new BloggerSkillError(
      'tool-blogger-skill: provider and model must be configured together, or both omitted to inherit the session target',
      BLOGGER_CONFIG_INVALID,
    )
  }
  return { provider: config.provider, model: config.model }
}
