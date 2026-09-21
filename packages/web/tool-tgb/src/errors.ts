/**
 * Structured errors for tgb.cn access. Every failure class carries a stable
 * machine-routable `code` so tool results, hooks, and UIs route on the code —
 * never by parsing `message`.
 * @module @deepseek-ai/dsh-tool-tgb/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * `TGB_AUTH_REQUIRED` — the configured cookie credential is missing or the
 * site answered a credential-bearing request with a redirect to the SSO login
 * host, which reads as an expired or absent login state.
 */
export const TGB_AUTH_REQUIRED = 'TGB_AUTH_REQUIRED'

/** `TGB_HTTP_STATUS` — the site answered with an unexpected non-2xx status. */
export const TGB_HTTP_STATUS = 'TGB_HTTP_STATUS'

/**
 * `TGB_REDIRECT_BLOCKED` — the site answered with a redirect that is not the
 * SSO login host. Credential-bearing requests never follow redirects (the web
 * package group rule), so this is a fail-loud signal instead.
 */
export const TGB_REDIRECT_BLOCKED = 'TGB_REDIRECT_BLOCKED'

/** `TGB_TIMEOUT` — one HTTP request exceeded the configured timeout budget. */
export const TGB_TIMEOUT = 'TGB_TIMEOUT'

/** `TGB_TOO_LARGE` — one response exceeded the configured size cap. */
export const TGB_TOO_LARGE = 'TGB_TOO_LARGE'

/** `TGB_PARSE_FAILED` — a page's structure no longer matches the parser's anchors. */
export const TGB_PARSE_FAILED = 'TGB_PARSE_FAILED'

/** `TGB_UPSTREAM_INVALID` — a JSON endpoint answered `status: false` or a shape the parser cannot trust. */
export const TGB_UPSTREAM_INVALID = 'TGB_UPSTREAM_INVALID'

/** One tgb.cn access failure, carrying one of the module's stable `TGB_*` codes. */
export class TgbError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'TgbError'
  }
}
