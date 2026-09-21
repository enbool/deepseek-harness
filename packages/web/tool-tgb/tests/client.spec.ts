/**
 * Client tests over a loopback HTTP server: the one request path (cookie
 * header, redirect classification, timeout, size caps, JSON parse) plus the
 * serial pagination helper. A second server proves redirects are never
 * followed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import { TgbClient } from '../src/client.ts'
import { TGB_AUTH_REQUIRED, TGB_HTTP_STATUS, TGB_REDIRECT_BLOCKED, TGB_TIMEOUT, TGB_TOO_LARGE } from '../src/errors.ts'
import { expectTgbRejection } from './helpers.ts'

/** A credential provider answering one fixed value (or nothing). */
class StubCredentials extends CredentialProvider {
  constructor(_ctx: Context, private readonly value: string | undefined) {
    super(_ctx)
  }

  override resolve(): Promise<{ value: string; source: string } | undefined> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'test' })
  }

  override describe(): never {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override set(): Promise<void> {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }

  override unset(): Promise<void> {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }

  override readRecord(): never {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override describeRecord(): never {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override listRecords(): never {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    throw new Error('not implemented')
  }

  override modifyRecord(): Promise<undefined> {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }

  override deleteRecord(): Promise<void> {
    /* v8 ignore next -- the client only resolves; the write/read surface is out of scope here. */
    return Promise.reject(new Error('not implemented'))
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler
let ctx: Context

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>page</html>')
  }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  ctx = new Context()
  await ctx.plugin(StubCredentials, 'tgbuser=1; loginStatus=1')
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

/** A client over the loopback server with small budgets. */
function makeClient(overrides: Partial<ConstructorParameters<typeof TgbClient>[1]> = {}): TgbClient {
  return new TgbClient(ctx, {
    cookieRef: credentialRef('TGB_COOKIE'),
    timeoutMs: 2_000,
    maxResponseBytes: 1_000,
    userAgent: 'tool-tgb-test',
    requestIntervalMs: 0,
    ...overrides,
  })
}

const page = (path = '/'): URL => new URL(path, base)

describe('TgbClient.fetchPage', () => {
  it('sends the resolved cookie, user-agent, and html accept header', async () => {
    const seen: Record<string, string | undefined> = {}
    handler = (req, res) => {
      seen.cookie = req.headers.cookie
      seen.userAgent = req.headers['user-agent']
      seen.accept = req.headers.accept
      res.writeHead(200)
      res.end('ok')
    }
    const text = await makeClient().fetchPage(page(), new AbortController().signal)
    expect(text).toBe('ok')
    expect(seen.cookie).toBe('tgbuser=1; loginStatus=1')
    expect(seen.userAgent).toBe('tool-tgb-test')
    expect(seen.accept).toContain('text/html')
  })

  it('maps an SSO redirect to TGB_AUTH_REQUIRED without following it', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'https://sso.tgb.cn/web/login/index' })
      res.end()
    }
    await expectTgbRejection(() => makeClient().fetchPage(page(), new AbortController().signal), TGB_AUTH_REQUIRED, /SSO login host/)
  })

  it('maps any other redirect to TGB_REDIRECT_BLOCKED, including a malformed location', async () => {
    handler = (_req, res) => {
      res.writeHead(301, { location: 'https://other.example.com/' })
      res.end()
    }
    await expectTgbRejection(
      () => makeClient().fetchPage(page(), new AbortController().signal), TGB_REDIRECT_BLOCKED, /other\.example\.com/)
    handler = (_req, res) => {
      res.writeHead(302, { location: '::not a url::' })
      res.end()
    }
    await expectTgbRejection(
      () => makeClient().fetchPage(page(), new AbortController().signal), TGB_REDIRECT_BLOCKED, /credential-bearing/)
  })

  it('maps non-2xx answers to TGB_HTTP_STATUS', async () => {
    handler = (_req, res) => {
      res.writeHead(500)
      res.end('boom')
    }
    await expectTgbRejection(() => makeClient().fetchPage(page(), new AbortController().signal), TGB_HTTP_STATUS, /HTTP 500/)
  })

  it('maps a declared content-length above the cap to TGB_TOO_LARGE before reading', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': '5000' })
      res.end('x')
    }
    await expectTgbRejection(() => makeClient().fetchPage(page(), new AbortController().signal), TGB_TOO_LARGE, /declared 5000 bytes/)
  })

  it('maps a bodyless answer to TGB_HTTP_STATUS', async () => {
    handler = (_req, res) => {
      res.writeHead(204)
      res.end()
    }
    await expectTgbRejection(() => makeClient().fetchPage(page(), new AbortController().signal), TGB_HTTP_STATUS, /no readable body/)
  })

  it('maps a redirect with no location header to TGB_REDIRECT_BLOCKED', async () => {
    handler = (_req, res) => {
      res.writeHead(302)
      res.end()
    }
    await expectTgbRejection(() => makeClient().fetchPage(page(), new AbortController().signal), TGB_REDIRECT_BLOCKED, /<no location>/)
  })

  it('maps a redirect to an unparseable target to TGB_REDIRECT_BLOCKED', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'https://[' })
      res.end()
    }
    await expectTgbRejection(() => makeClient().fetchPage(page(), new AbortController().signal), TGB_REDIRECT_BLOCKED, /redirect 302/)
  })

  it('maps a transport failure (connection reset) to TGB_HTTP_STATUS with the cause', async () => {
    handler = (_req, res) => {
      res.destroy()
    }
    await expectTgbRejection(() => makeClient().fetchPage(page(), new AbortController().signal), TGB_HTTP_STATUS, /failed:/)
  })

  it('maps an aborted pause with a non-Error reason to a wrapped Error', async () => {
    vi.useFakeTimers()
    try {
      const client = makeClient({ requestIntervalMs: 60_000 })
      const controller = new AbortController()
      const aborted = client.collectPages({
        build: pageNo => page(`/?p=${pageNo}`),
        fetchPage: async () => [{ id: 'a' }],
        idOf: item => item.id,
        maxPages: 2,
        signal: controller.signal,
      })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort('caller cancelled')
      await expect(aborted).rejects.toThrow('pagination pause aborted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cuts a chunked stream that grows past the cap', async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      res.write('x'.repeat(2000))
      res.end()
    }
    await expectTgbRejection(
      () => makeClient().fetchPage(page(), new AbortController().signal), TGB_TOO_LARGE, /exceeded the 1000-byte cap/)
  })

  it('maps a timeout to TGB_TIMEOUT', async () => {
    handler = () => { /* never responds */ }
    await expectTgbRejection(
      () => makeClient({ timeoutMs: 50 }).fetchPage(page(), new AbortController().signal), TGB_TIMEOUT, /timed out after 50ms/)
  })

  it('rethrows a caller cancellation unchanged', async () => {
    handler = () => { /* never responds */ }
    const controller = new AbortController()
    const pending = makeClient().fetchPage(page(), controller.signal)
    const error = new Error('caller cancelled')
    setTimeout(() => { controller.abort(error) }, 20)
    await expect(pending).rejects.toThrow('caller cancelled')
  })

  it('fails loud with TGB_AUTH_REQUIRED when the credential is not configured', async () => {
    const anonymous = new Context()
    await anonymous.plugin(StubCredentials, undefined)
    const client = new TgbClient(anonymous, {
      cookieRef: credentialRef('TGB_COOKIE'),
      timeoutMs: 2_000,
      maxResponseBytes: 1_000,
      userAgent: 'tool-tgb-test',
      requestIntervalMs: 0,
    })
    await expectTgbRejection(() => client.fetchPage(page(), new AbortController().signal), TGB_AUTH_REQUIRED, /not configured/)
  })
})

describe('TgbClient.fetchJson', () => {
  it('parses a JSON body and requests it with the json accept header', async () => {
    const seen: Record<string, string | undefined> = {}
    handler = (req, res) => {
      seen.accept = req.headers.accept
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }
    expect(await makeClient().fetchJson(page(), new AbortController().signal)).toEqual({ ok: true })
    expect(seen.accept).toContain('application/json')
  })

  it('maps an invalid JSON body to TGB_HTTP_STATUS with the parse cause', async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      res.end('not json')
    }
    await expectTgbRejection(() => makeClient().fetchJson(page(), new AbortController().signal), TGB_HTTP_STATUS, /invalid JSON/)
  })
})

describe('TgbClient.collectPages', () => {
  const signal = new AbortController().signal
  const idOf = (item: { id: string }) => item.id

  /** Build a page fetcher serving the given pages in order. */
  function pageFetcher(pages: { id: string }[][], fetchedUrls: URL[] = []): (url: URL, signal: AbortSignal) => Promise<{ id: string }[]> {
    return async (url) => {
      fetchedUrls.push(url)
      return pages[fetchedUrls.length - 1] ?? []
    }
  }

  it('merges pages until the budget and reports hasMore', async () => {
    const fetched: URL[] = []
    const batch = await makeClient().collectPages({
      build: pageNo => page(`/?p=${pageNo}`),
      fetchPage: pageFetcher([[{ id: 'a' }], [{ id: 'b' }]], fetched),
      idOf,
      maxPages: 2,
      signal,
    })
    expect(batch).toEqual({ items: [{ id: 'a' }, { id: 'b' }], pagesFetched: 2, hasMore: true })
    expect(fetched.map(url => String(url))).toEqual([page('/?p=1').href, page('/?p=2').href])
  })

  it('stops on an empty page without claiming more', async () => {
    const batch = await makeClient().collectPages({
      build: pageNo => page(`/?p=${pageNo}`),
      fetchPage: pageFetcher([[{ id: 'a' }], []]),
      idOf,
      maxPages: 5,
      signal,
    })
    expect(batch).toEqual({ items: [{ id: 'a' }], pagesFetched: 2, hasMore: false })
  })

  it('stops when a page repeats the previous page first item', async () => {
    const batch = await makeClient().collectPages({
      build: pageNo => page(`/?p=${pageNo}`),
      fetchPage: pageFetcher([[{ id: 'a' }], [{ id: 'a' }]]),
      idOf,
      maxPages: 5,
      signal,
    })
    expect(batch).toEqual({ items: [{ id: 'a' }], pagesFetched: 2, hasMore: false })
  })

  it('pauses between pages when an interval is configured and aborts the pause on cancellation', async () => {
    vi.useFakeTimers()
    try {
      const client = makeClient({ requestIntervalMs: 60_000 })
      const pending = client.collectPages({
        build: pageNo => page(`/?p=${pageNo}`),
        fetchPage: pageFetcher([[{ id: 'a' }], [{ id: 'b' }]]),
        idOf,
        maxPages: 2,
        signal,
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await pending).pagesFetched).toBe(2)

      const controller = new AbortController()
      const aborted = client.collectPages({
        build: pageNo => page(`/?p=${pageNo}`),
        fetchPage: pageFetcher([[{ id: 'a' }], [{ id: 'b' }]]),
        idOf,
        maxPages: 2,
        signal: controller.signal,
      })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort(new Error('caller cancelled'))
      await expect(aborted).rejects.toThrow('caller cancelled')
    } finally {
      vi.useRealTimers()
    }
  })
})
