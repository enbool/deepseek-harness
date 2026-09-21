/**
 * Real composition test: the tool-tgb plugin boots through the real Loader
 * unwrap path over a real tool registry and a real credential provider, and
 * one tool call runs end-to-end through the real client and parser with only
 * the network transport stubbed. Also guards the namespace export shape (see
 * the tool-web postmortem: a default export would collapse the namespace and
 * drop `inject`).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolTgb from '@deepseek-ai/dsh-tool-tgb'

const testToolSignal = new AbortController().signal

/** A minimal credential provider answering one fixed value. */
class StubCredentials extends CredentialProvider {
  private readonly value: string

  constructor(_ctx: Context, config: { value: string }) {
    super(_ctx)
    this.value = config.value
  }

  override resolve(): Promise<{ value: string; source: string }> {
    return Promise.resolve({ value: this.value, source: 'test' })
  }

  override describe(): never {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    throw new Error('not implemented')
  }

  override set(): Promise<void> {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    return Promise.reject(new Error('not implemented'))
  }

  override unset(): Promise<void> {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    return Promise.reject(new Error('not implemented'))
  }

  override readRecord(): never {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    throw new Error('not implemented')
  }

  override describeRecord(): never {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    throw new Error('not implemented')
  }

  override listRecords(): never {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    throw new Error('not implemented')
  }

  override modifyRecord(): Promise<undefined> {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    return Promise.reject(new Error('not implemented'))
  }

  override deleteRecord(): Promise<void> {
    /* v8 ignore next -- composition here only resolves; the write/read surface is out of scope. */
    return Promise.reject(new Error('not implemented'))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dsh-tool-tgb real composition', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolTgb).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolTgb) as Record<string, unknown>
    expect(unwrapped).toBe(toolTgb)
    expect(unwrapped.name).toBe('tool-tgb')
    expect(unwrapped.inject).toEqual(['tools', 'credentials'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots through the unwrapped module and runs one tool call end-to-end', async () => {
    const moreTopicHtml = readFileSync(fileURLToPath(new URL('./fixtures/more-topic.html', import.meta.url)), 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(moreTopicHtml, { status: 200, headers: { 'content-type': 'text/html' } })))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubCredentials, { value: 'tgbuser=1' })
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolTgb) as Parameters<Context['plugin']>[0]
    // Mounting the collapsed shape would throw for missing injection here.
    const fiber = await ctx.plugin(unwrapped, { cookie: 'TGB_COOKIE' })
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(['tgb_get_topics']))

    const out = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('integration-1'),
      name: 'tgb_get_topics',
      arguments: { userID: 905478 },
    })
    expect(out.isError).toBe(false)
    expect((out.value as { topics: unknown[] }).topics).toHaveLength(4)

    // Disposal through the real fiber unregisters the tools.
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('tgb_get_topics')
  })
})
