/**
 * Structured errors for blogger harvesting and distillation. Every failure
 * carries a stable machine-routable `code` so tool results, hooks, and UIs route
 * on the code — never by parsing `message`.
 * @module @deepseek-ai/dsh-tool-blogger-skill/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** `BLOGGER_CORPUS_MISSING` — no harvest has stored a corpus for the requested blogger. */
export const BLOGGER_CORPUS_MISSING = 'BLOGGER_CORPUS_MISSING'

/** `BLOGGER_CORPUS_EMPTY` — the stored corpus holds neither a post nor a reply to distill. */
export const BLOGGER_CORPUS_EMPTY = 'BLOGGER_CORPUS_EMPTY'

/** `BLOGGER_CORPUS_INVALID` — the stored corpus file no longer matches the record grammar. */
export const BLOGGER_CORPUS_INVALID = 'BLOGGER_CORPUS_INVALID'

/** `BLOGGER_DISTILL_ROUTE_UNSET` — no model route is configured and the session has none to inherit. */
export const BLOGGER_DISTILL_ROUTE_UNSET = 'BLOGGER_DISTILL_ROUTE_UNSET'

/** `BLOGGER_PROFILE_INVALID` — the distillation model answered off-format. */
export const BLOGGER_PROFILE_INVALID = 'BLOGGER_PROFILE_INVALID'

/** `BLOGGER_CONFIG_INVALID` — the plugin config names an incomplete distillation route. */
export const BLOGGER_CONFIG_INVALID = 'BLOGGER_CONFIG_INVALID'

/** `BLOGGER_EVIDENCE_TOO_LARGE` — the merged window notes exceed one request's token budget. */
export const BLOGGER_EVIDENCE_TOO_LARGE = 'BLOGGER_EVIDENCE_TOO_LARGE'

/** One blogger-harvest or distillation failure, carrying one of the module's stable codes. */
export class BloggerSkillError extends HarnessError {
  /**
   * @param message - the failure detail, naming the blogger or file it concerns.
   * @param code - one of the module's stable codes.
   * @param options - optional cause chain.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'BloggerSkillError'
  }
}
