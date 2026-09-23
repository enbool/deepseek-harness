/**
 * Shared test scaffolding for the tgb.cn blogger source: the recorded page
 * fixtures, a fixed-value credential provider, and the transport stub that
 * routes requests to those fixtures.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** The recorded topic-list page. */
export const moreTopicHtml = readFileSync(fileURLToPath(new URL('./fixtures/more-topic.html', import.meta.url)), 'utf8')

/** The recorded topic-detail page. */
export const topicContentHtml = readFileSync(fileURLToPath(new URL('./fixtures/topic-content.html', import.meta.url)), 'utf8')

/** The recorded reply-list page. */
export const moreRepliesHtml = readFileSync(fileURLToPath(new URL('./fixtures/more-replies.html', import.meta.url)), 'utf8')

/** A credential provider answering one fixed value. */
export class StubCredentials extends CredentialProvider {
  private readonly value: string

  constructor(_ctx: Context, config: { value: string }) {
    super(_ctx)
    this.value = config.value
  }

  override resolve(): Promise<{ value: string; source: string }> {
    return Promise.resolve({ value: this.value, source: 'test' })
  }

  /* v8 ignore start -- this suite only resolves; the credential write surface is out of scope. */
  override describe(): never {
    throw new Error('not implemented')
  }

  override set(): Promise<void> {
    return Promise.reject(new Error('not implemented'))
  }

  override unset(): Promise<void> {
    return Promise.reject(new Error('not implemented'))
  }

  override readRecord(): never {
    throw new Error('not implemented')
  }

  override describeRecord(): never {
    throw new Error('not implemented')
  }

  override listRecords(): never {
    throw new Error('not implemented')
  }

  override modifyRecord(): Promise<undefined> {
    return Promise.reject(new Error('not implemented'))
  }

  override deleteRecord(): Promise<void> {
    return Promise.reject(new Error('not implemented'))
  }
  /* v8 ignore stop */
}

/** Route the stubbed transport by URL to the recorded fixtures. */
export function stubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: URL | string) => {
    const href = input instanceof URL ? input.href : input
    const respond = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
    if (href.includes('/user/blog/moreTopic')) return respond(moreTopicHtml)
    if (href.includes('/user/blog/moreReplyMod')) return respond(moreRepliesHtml)
    if (href.includes('/a/')) return respond(topicContentHtml)
    throw new Error(`stub fetch has no answer for ${href}`)
  })
}
