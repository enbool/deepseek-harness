/**
 * Structured errors for the blogger source seam. Every failure class carries a
 * stable machine-routable `code` so tool results, hooks, and UIs route on the
 * code — never by parsing `message`.
 * @module @deepseek-ai/dsh-blogger/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** `BLOGGER_SOURCE_DUPLICATE` — a source with this id is already registered. */
export const BLOGGER_SOURCE_DUPLICATE = 'BLOGGER_SOURCE_DUPLICATE'

/** `BLOGGER_SOURCE_UNKNOWN` — the caller named a source id that is not registered. */
export const BLOGGER_SOURCE_UNKNOWN = 'BLOGGER_SOURCE_UNKNOWN'

/** `BLOGGER_SOURCE_UNRECOGNIZED` — no registered source recognizes the user reference. */
export const BLOGGER_SOURCE_UNRECOGNIZED = 'BLOGGER_SOURCE_UNRECOGNIZED'

/** `BLOGGER_SOURCE_AMBIGUOUS` — several registered sources recognize the same user reference. */
export const BLOGGER_SOURCE_AMBIGUOUS = 'BLOGGER_SOURCE_AMBIGUOUS'

/** `BLOGGER_REFERENCE_INVALID` — a source was asked to resolve a reference its own grammar rejects. */
export const BLOGGER_REFERENCE_INVALID = 'BLOGGER_REFERENCE_INVALID'

/** One blogger source failure, carrying one of the module's stable `BLOGGER_*` codes. */
export class BloggerError extends HarnessError {
  /**
   * @param message - the failure detail, naming the reference or source id.
   * @param code - one of the module's `BLOGGER_*` codes.
   * @param options - optional cause chain.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'BloggerError'
  }
}
