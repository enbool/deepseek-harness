/**
 * Credential-bearing HTTP client for tgb.cn: one fetch path with a per-operation
 * cookie resolution, a hard no-redirect policy (the web package group rule for
 * credential-bearing requests), cooperative timeouts, and a response size cap —
 * plus the serial pagination helper the list tools share.
 * @module @deepseek-ai/dsh-tool-tgb/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  TGB_AUTH_REQUIRED,
  TGB_HTTP_STATUS,
  TGB_REDIRECT_BLOCKED,
  TGB_TIMEOUT,
  TGB_TOO_LARGE,
  TgbError,
} from './errors.ts'
import type { PageBatch } from './types.ts'

/** Options every client method honors; built once from the plugin's resolved config. */
export interface TgbClientOptions {
  /** Credential reference holding the tgb.cn cookie header value. */
  readonly cookieRef: CredentialRef
  /** Per-request cooperative timeout budget (ms). */
  readonly timeoutMs: number
  /** Per-response size cap in bytes. */
  readonly maxResponseBytes: number
  /** Request User-Agent header value. */
  readonly userAgent: string
  /** Minimum pause between consecutive paginated requests (ms). */
  readonly requestIntervalMs: number
}

/**
 * The `sso.tgb.cn` login host. A credential-bearing request answered with a
 * redirect here reads as an expired or absent login state, which is the one
 * redirect this client classifies specially.
 */
const SSO_HOST = 'sso.tgb.cn'

/** Accept header for the site's server-rendered HTML pages. */
const ACCEPT_HTML = 'text/html,application/xhtml+xml'

/** Accept header for the site's JSON endpoints. */
const ACCEPT_JSON = 'application/json, text/plain, */*'

/**
 * Options for {@link TgbClient.collectPages}: how to build each page's URL,
 * fetch-and-parse it, and identify items for the duplicate-first-item guard.
 */
export interface CollectPagesOptions<T> {
  /** Build the URL for one 1-based page number. */
  readonly build: (pageNo: number) => URL
  /** Fetch one page's raw body and parse it to items. */
  readonly fetchPage: (url: URL, signal: AbortSignal) => Promise<T[]>
  /** Stable per-item identity (topic id, reply id, …) for the overlap guard. */
  readonly idOf: (item: T) => string
  /** Maximum pages this call may fetch, inclusive. */
  readonly maxPages: number
  /** Cancellation signal forwarded to every page fetch and the inter-page pause. */
  readonly signal: AbortSignal
}

/**
 * Read one response body as UTF-8 text under a byte cap, refusing early on a
 * declared `content-length` above the cap and cutting a stream that grows past
 * it, so a lying header cannot bypass the bound.
 *
 * @param response - the fetch response to read.
 * @param maxBytes - the response size cap in bytes.
 * @returns the decoded body text.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number.parseInt(declared, 10) > maxBytes) {
    throw new TgbError(`tgb.cn response declared ${declared} bytes, above the ${maxBytes}-byte cap`, TGB_TOO_LARGE)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    throw new TgbError('tgb.cn response carried no readable body', TGB_HTTP_STATUS)
  }
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    received += value.byteLength
    if (received > maxBytes) {
      void reader.cancel()
      throw new TgbError(`tgb.cn response exceeded the ${maxBytes}-byte cap`, TGB_TOO_LARGE)
    }
    text += decoder.decode(value, { stream: true })
  }
}

/**
 * The tgb.cn HTTP client. One instance per plugin apply; every method resolves
 * the cookie credential at call time so an updated credential reaches the next
 * request without a plugin restart.
 */
export class TgbClient {
  constructor(
    private readonly ctx: Context,
    private readonly options: TgbClientOptions,
  ) {}

  /**
   * Resolve the configured cookie credential to its current header value.
   *
   * @returns the cookie header value.
   */
  private async resolveCookie(): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(this.options.cookieRef)
    if (resolved === undefined) {
      throw new TgbError(
        `tgb.cn cookie credential "${this.options.cookieRef}" is not configured; set it to your logged-in tgb.cn Cookie header`,
        TGB_AUTH_REQUIRED,
      )
    }
    return resolved.value
  }

  /**
   * Issue one credential-bearing GET and return its body text. Redirects are
   * never followed: a 3xx whose location points at the SSO login host maps to
   * `TGB_AUTH_REQUIRED` (the site's cookie-expired signal), any other 3xx to
   * `TGB_REDIRECT_BLOCKED`, and any other non-2xx to `TGB_HTTP_STATUS`.
   *
   * @param url - the absolute URL to fetch.
   * @param signal - cancellation signal fused with the configured timeout.
   * @returns the decoded body text.
   */
  async fetchPage(url: URL, signal: AbortSignal): Promise<string> {
    return this.request(url, signal, ACCEPT_HTML)
  }

  /**
   * Issue one credential-bearing GET and parse its body as JSON. Status and
   * redirect handling match {@link fetchPage}; a body that is not valid JSON
   * surfaces as `TGB_HTTP_STATUS` with the parse failure chained.
   *
   * @param url - the absolute URL to fetch.
   * @param signal - cancellation signal fused with the configured timeout.
   * @returns the parsed JSON value.
   */
  async fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
    const text = await this.request(url, signal, ACCEPT_JSON)
    try {
      return JSON.parse(text)
    } catch (error: unknown) {
      throw new TgbError(`tgb.cn endpoint ${url.href} returned invalid JSON`, TGB_HTTP_STATUS, { cause: error })
    }
  }

  /**
   * The one request path both entry points share.
   *
   * @param url - the absolute URL to fetch.
   * @param signal - caller cancellation signal.
   * @param accept - Accept header value for the expected body kind.
   * @returns the decoded body text.
   */
  private async request(url: URL, signal: AbortSignal, accept: string): Promise<string> {
    const cookie = await this.resolveCookie()
    const pageDeadline = deadline(signal, this.options.timeoutMs, TGB_TIMEOUT)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { cookie, 'user-agent': this.options.userAgent, accept },
        signal: pageDeadline.signal,
      })
      this.assertFetchableStatus(url, response)
      return await readBodyCapped(response, this.options.maxResponseBytes)
    } catch (error: unknown) {
      if (error instanceof TgbError) throw error
      // Classify by the fused signal, not the thrown value: a timeout reason
      // stamped on it is this client's budget; any other abort on it is caller
      // cancellation and propagates unchanged.
      const timeout = timeoutOf(pageDeadline.signal, TGB_TIMEOUT)
      if (timeout !== undefined) {
        throw new TgbError(`tgb.cn request to ${url.href} timed out after ${timeout.timeoutMs}ms`, TGB_TIMEOUT, { cause: error })
      }
      if (pageDeadline.signal.aborted) throw error
      throw new TgbError(`tgb.cn request to ${url.href} failed: ${String(error)}`, TGB_HTTP_STATUS, { cause: error })
    } finally {
      pageDeadline[Symbol.dispose]()
    }
  }

  /**
   * Reject every status that is not a directly usable 2xx before the body is
   * read, so redirects and upstream failures never half-apply.
   *
   * @param url - the requested URL, for error messages.
   * @param response - the response to classify.
   */
  private assertFetchableStatus(url: URL, response: Response): void {
    if (response.status >= 200 && response.status < 300) return
    const location = response.headers.get('location') ?? ''
    if (response.status >= 300 && response.status < 400) {
      if (redirectHost(location) === SSO_HOST) {
        throw new TgbError(
          'tgb.cn redirected the request to its SSO login host; the configured cookie credential is missing or expired',
          TGB_AUTH_REQUIRED,
        )
      }
      throw new TgbError(
        `tgb.cn responded with redirect ${response.status} to ${location || '<no location>'}; credential-bearing requests never follow redirects`,
        TGB_REDIRECT_BLOCKED,
      )
    }
    throw new TgbError(`tgb.cn responded with HTTP ${response.status} for ${url.href}`, TGB_HTTP_STATUS)
  }

  /**
   * Fetch pages serially and merge their items until one stop condition hits:
   * an empty page, a page whose first item repeats the previous page's first
   * item (the site re-serves page one past its end), or the page budget.
   *
   * @typeParam T - the parsed item type.
   * @param options - page builder, fetcher, identity extractor, budget, and signal.
   * @returns the merged items, the number of pages fetched, and whether fresh data remained.
   */
  async collectPages<T>(options: CollectPagesOptions<T>): Promise<PageBatch<T>> {
    const items: T[] = []
    let pagesFetched = 0
    let previousFirstId: string | undefined
    for (let pageNo = 1; pageNo <= options.maxPages; pageNo += 1) {
      if (pagesFetched > 0 && this.options.requestIntervalMs > 0) {
        await pause(this.options.requestIntervalMs, options.signal)
      }
      const pageItems = await options.fetchPage(options.build(pageNo), options.signal)
      pagesFetched += 1
      const first = pageItems[0]
      if (first === undefined) return { items, pagesFetched, hasMore: false }
      const firstId = options.idOf(first)
      if (firstId === previousFirstId) return { items, pagesFetched, hasMore: false }
      previousFirstId = firstId
      items.push(...pageItems)
      if (pageNo === options.maxPages) return { items, pagesFetched, hasMore: true }
    }
    /* v8 ignore next -- the loop returns on every path: empty, duplicate, and budget exhaustion. */
    return { items, pagesFetched, hasMore: false }
  }
}

/**
 * Extract the hostname of a redirect target without throwing on malformed or
 * relative locations.
 *
 * @param location - the raw `location` header value.
 * @returns the target hostname, or the empty string when it cannot be parsed.
 */
function redirectHost(location: string): string {
  if (location.length === 0) return ''
  try {
    return new URL(location, 'https://www.tgb.cn').hostname
  } catch {
    return ''
  }
}

/**
 * Pause between paginated requests, aborted promptly by the caller's signal.
 *
 * @param ms - the pause duration.
 * @param signal - cancellation signal.
 */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      resolve()
    }
    function onAbort(): void {
      clearTimeout(timer)
      reject(pauseAbortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The reason to reject a paused wait with: the abort's own reason when it is
 * an Error (the caller's cancellation, or the default AbortError), otherwise
 * a wrapper that keeps the foreign reason as its cause.
 *
 * @param signal - the aborted signal.
 * @returns an Error rejection reason.
 */
function pauseAbortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('pagination pause aborted', { cause: reason })
}
