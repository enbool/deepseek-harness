/**
 * Model-facing taoguba (tgb.cn) data tools. This package registers five tools —
 * topic list, topic content, replies, follows, and home sections — over one
 * credential-bearing site client. The site login state comes from a
 * credential-reference config field resolved per call; all other limits
 * (pagination budget, timeouts, response and output caps) are deployment
 * config, never model arguments.
 *
 * The entry also exports the reusable tgb.cn access primitives — {@link TgbClient}
 * and the three user-activity page parsers — so another package can read the
 * same pages under its own model contract without duplicating the request path.
 * @module @deepseek-ai/dsh-tool-tgb
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { TgbClient } from './client.ts'
import { applyTgbTools } from './tools.ts'

export type {
  FollowUser, HomeSections, HotStock, PageBatch, ReplyItem, StockQuote, TopicContent, TopicSummary, WeekUpStar,
} from './types.ts'
export { TgbError } from './errors.ts'
export type { FollowListPage, LoginState } from './follows.ts'
export { TgbClient } from './client.ts'
export type { TgbClientOptions, CollectPagesOptions } from './client.ts'
export { parseRepliesPage } from './replies.ts'
export { moreRepliesUrl, moreTopicUrl, topicUrl } from './sites.ts'
export { parseTopicContentPage } from './topic-content.ts'
export { parseTopicsPage } from './topics.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-tgb'

/** Services required by the tgb tool suite. */
export const inject = ['tools', 'credentials']

/** Default per-request cooperative timeout budget (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default page budget for one paginated tool call. */
export const DEFAULT_MAX_PAGES = 5

/** Default per-response size cap (bytes). */
export const DEFAULT_MAX_RESPONSE_BYTES = 4_000_000

/** Default cap on one complete rendered tool output (characters). */
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000

/** Default minimum pause between consecutive paginated requests (ms). */
export const DEFAULT_REQUEST_INTERVAL_MS = 500

/**
 * The User-Agent sent with every request. The site serves the same
 * server-rendered pages regardless, but a real browser UA keeps the requests
 * ordinary.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Plugin config: the site login state and every deployment-owned bound. */
export interface Config {
  /**
   * Credential reference holding the logged-in tgb.cn `Cookie` request-header
   * value (copy it from a logged-in browser's request headers). Resolved once
   * per tool call, so updating the credential never needs a plugin restart.
   */
  readonly cookie: string
  /** Per-request cooperative timeout budget (ms). Defaults to 30000. */
  readonly timeoutMs?: number
  /** Page budget for one paginated tool call; the tools reject larger `maxPages`. Defaults to 5. */
  readonly maxPages?: number
  /** Per-response size cap in bytes. Defaults to 4000000. */
  readonly maxResponseBytes?: number
  /** Cap on one complete rendered tool output in characters. Defaults to 200000. */
  readonly maxOutputChars?: number
  /** Minimum pause between consecutive paginated requests (ms). Defaults to 500. */
  readonly requestIntervalMs?: number
  /** Request User-Agent header value. Defaults to a current Chrome UA. */
  readonly userAgent?: string
}

export const Config: z<Config> = z.object({
  cookie: z.string().role('credential-ref').required(),
  timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_TIMEOUT_MS),
  maxPages: z.number().step(1).min(1).max(50).default(DEFAULT_MAX_PAGES),
  maxResponseBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RESPONSE_BYTES),
  maxOutputChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_OUTPUT_CHARS),
  requestIntervalMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_INTERVAL_MS),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Register the tgb tools. The schema enforces every numeric bound at load;
 * the cookie reference grammar is the one load-time fact the schema cannot
 * express, so `credentialRef` validates it here, fail-loud. The credential
 * value itself resolves per call, so updating the referenced credential
 * reaches the next call without a restart.
 *
 * @param ctx - context whose `tools` registry receives the five registrations.
 * @param config - the resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  const client = new TgbClient(ctx, {
    cookieRef: credentialRef(resolved.cookie),
    timeoutMs: resolved.timeoutMs,
    maxResponseBytes: resolved.maxResponseBytes,
    userAgent: resolved.userAgent,
    requestIntervalMs: resolved.requestIntervalMs,
  })
  applyTgbTools(ctx, client, {
    maxPages: resolved.maxPages,
    timeoutMs: resolved.timeoutMs,
    maxOutputChars: resolved.maxOutputChars,
  })
}
