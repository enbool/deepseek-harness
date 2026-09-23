/**
 * Plugin entry for the tgb.cn blogger source. It builds one credential-bearing
 * tgb.cn client from the resolved config and registers a {@link TgbBloggerSource}
 * on `ctx.bloggers`; the site login state is a credential reference resolved per
 * request, so updating it never needs a plugin restart. Every bound the client
 * enforces is a deployment setting here, never a model argument.
 * @module @deepseek-ai/dsh-blogger-source-tgb
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  TgbClient,
} from '@deepseek-ai/dsh-tool-tgb'
import z from '@deepseek-ai/schemastery'
import { TgbBloggerSource } from './source.ts'

export { TGB_SOURCE_DISPLAY_NAME, TGB_SOURCE_ID, TgbBloggerSource } from './source.ts'
export { parseTgbReference } from './reference.ts'
export type { TgbReference } from './reference.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'blogger-source-tgb'

/** Services this plugin contributes to and reads from. */
export const inject = ['bloggers', 'credentials']

/** Plugin config: the site login state and every deployment-owned request bound. */
export interface Config {
  /**
   * Credential reference holding the logged-in tgb.cn `Cookie` request-header
   * value (copy it from a logged-in browser's request headers). Resolved once
   * per request, so updating it never needs a plugin restart.
   */
  readonly cookie: string
  /** Per-request cooperative timeout budget (ms). Defaults to 30000. */
  readonly timeoutMs?: number
  /** Per-response size cap in bytes. Defaults to 4000000. */
  readonly maxResponseBytes?: number
  /** Minimum pause between consecutive paginated requests (ms). Defaults to 500. */
  readonly requestIntervalMs?: number
  /** Request User-Agent header value. Defaults to a current Chrome UA. */
  readonly userAgent?: string
}

export const Config: z<Config> = z.object({
  cookie: z.string().role('credential-ref').required(),
  timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_TIMEOUT_MS),
  maxResponseBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RESPONSE_BYTES),
  requestIntervalMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REQUEST_INTERVAL_MS),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/**
 * Register the tgb.cn blogger source. The schema enforces every numeric bound at
 * load; the cookie reference grammar is the one load-time fact the schema cannot
 * express, so `credentialRef` validates it here, fail-loud.
 *
 * @param ctx - context whose `bloggers` registry receives the source.
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
  ctx.bloggers.register(new TgbBloggerSource(client))
}
