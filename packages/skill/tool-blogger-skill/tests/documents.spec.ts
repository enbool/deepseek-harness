/**
 * Offline documents as corpus records: the frontmatter grammar, the title and
 * kind fallbacks, and the post and reply records one document becomes.
 */

import { describe, expect, it } from 'vitest'
import { documentPost, documentReply, parseDocument, UNKNOWN_DATE } from '../src/documents.ts'

const PATH = '/saved/deleted-call.md'

describe('parseDocument', () => {
  it('reads every recognized frontmatter field', () => {
    const text = [
      '---',
      'title: The 2015 crash call',
      'publishedAt: 2015-06-12',
      'kind: reply',
      'platformId: codeA/7',
      'topicTitle: Someone else',
      'topicUrl: https://stub.example/a/other',
      'note: ignored bookkeeping',
      '---',
      '',
      'Sell into strength.',
    ].join('\n')

    expect(parseDocument(PATH, text, 'post')).toEqual({
      path: PATH,
      title: 'The 2015 crash call',
      publishedAt: '2015-06-12',
      kind: 'reply',
      platformId: 'codeA/7',
      topicTitle: 'Someone else',
      topicUrl: 'https://stub.example/a/other',
      bodyMarkdown: 'Sell into strength.',
    })
  })

  it('strips one layer of matching quotes and keeps unmatched ones', () => {
    const quoted = '---\ntitle: "Quoted: title"\nkind: \'post\'\n---\nbody'
    expect(parseDocument(PATH, quoted, 'reply')).toMatchObject({ title: 'Quoted: title', kind: 'post' })

    const unmatched = '---\ntitle: "unterminated\n---\nbody'
    expect(parseDocument(PATH, unmatched, 'post').title).toBe('"unterminated')
  })

  it('ignores a frontmatter line with no colon, an empty key, and an empty value', () => {
    const text = [
      '---',
      'just a note with no separator',
      ': orphaned value',
      'title:',
      'kind: post',
      '---',
      'body text',
    ].join('\n')

    expect(parseDocument(PATH, text, 'reply')).toMatchObject({
      title: 'deleted-call',
      kind: 'post',
      publishedAt: UNKNOWN_DATE,
      bodyMarkdown: 'body text',
    })
  })

  it('treats a document with no frontmatter as all body', () => {
    const text = '# A heading\n\nBody text.\n\n'

    expect(parseDocument(PATH, text, 'post')).toEqual({
      path: PATH,
      title: 'A heading',
      publishedAt: UNKNOWN_DATE,
      kind: 'post',
      bodyMarkdown: '# A heading\n\nBody text.',
    })
  })

  it('accepts a CRLF frontmatter block', () => {
    const text = '---\r\ntitle: CRLF doc\r\nkind: reply\r\n---\r\nbody line'

    expect(parseDocument(PATH, text, 'post')).toEqual({
      path: PATH,
      title: 'CRLF doc',
      publishedAt: UNKNOWN_DATE,
      kind: 'reply',
      bodyMarkdown: 'body line',
    })
  })

  it('titles a document from its first level-one heading', () => {
    const text = '# Heading title\n\n## A deeper heading\n\nbody'

    expect(parseDocument(PATH, text, 'post').title).toBe('Heading title')
  })

  it('titles a document from its file name when it carries no heading', () => {
    expect(parseDocument('/saved/2026-01-02 deleted-call.md', 'no heading here', 'post').title)
      .toBe('2026-01-02 deleted-call')
  })

  it('falls back to the caller kind when the frontmatter names none', () => {
    expect(parseDocument(PATH, 'body only', 'reply').kind).toBe('reply')
  })

  it('rejects a document whose kind is neither post nor reply', () => {
    expect(() => parseDocument(PATH, '---\nkind: essay\n---\nbody', 'post'))
      .toThrow(expect.objectContaining({
        code: 'BLOGGER_DOCUMENT_INVALID',
        message: expect.stringContaining('neither "post" nor "reply"') as string,
      }))
  })

  it('rejects a document with no body', () => {
    expect(() => parseDocument(PATH, '---\ntitle: Empty\n---\n\n \n', 'post'))
      .toThrow(expect.objectContaining({
        code: 'BLOGGER_DOCUMENT_INVALID',
        message: expect.stringContaining(`blogger document ${PATH} has no body`) as string,
      }))
  })
})

describe('documentPost', () => {
  it('maps a document to an offline post keyed by its platform id', () => {
    const document = parseDocument('/saved/a.md', '---\nplatformId: codeA\ntitle: T\npublishedAt: 2026-01-02\n---\nbody', 'post')

    expect(documentPost(document)).toEqual({
      id: 'codeA',
      url: '/saved/a.md',
      title: 'T',
      publishedAt: '2026-01-02',
      bodyMarkdown: 'body',
      origin: 'offline',
      documentPath: '/saved/a.md',
    })
  })

  it('keys a document that names no platform id by its file name', () => {
    const document = parseDocument('/saved/a.md', 'body', 'post')

    expect(documentPost(document)).toEqual({
      id: 'offline:a.md',
      url: '/saved/a.md',
      title: 'a',
      publishedAt: UNKNOWN_DATE,
      bodyMarkdown: 'body',
      origin: 'offline',
      documentPath: '/saved/a.md',
    })
  })

  it('gives one file name in two directories the same record id', () => {
    const saved = documentPost(parseDocument('/saved/a.md', 'first body', 'post'))
    const moved = documentPost(parseDocument('/archive/a.md', 'second body', 'post'))

    expect(moved.id).toBe(saved.id)
    expect(moved.documentPath).toBe('/archive/a.md')
  })

  it('gives an edited document the record id its unchanged file name already owns', () => {
    const before = documentPost(parseDocument('/saved/a.md', '---\ntitle: Before\n---\nfirst body', 'post'))
    const after = documentPost(parseDocument('/saved/a.md', '---\ntitle: After\n---\nsecond body', 'post'))

    expect(after.id).toBe(before.id)
    expect(after.bodyMarkdown).toBe('second body')
  })
})

describe('documentReply', () => {
  it('maps a reply document onto the topic it names', () => {
    const text = [
      '---',
      'kind: reply',
      'platformId: codeA/7',
      'publishedAt: 2015-06-12',
      'topicTitle: Someone else',
      'topicUrl: https://stub.example/a/other',
      '---',
      'Sell into strength.',
    ].join('\n')

    expect(documentReply(parseDocument(PATH, text, 'post'))).toEqual({
      id: 'codeA/7',
      url: 'https://stub.example/a/other',
      topicTitle: 'Someone else',
      topicUrl: 'https://stub.example/a/other',
      repliedAt: '2015-06-12',
      body: 'Sell into strength.',
      origin: 'offline',
      documentPath: PATH,
    })
  })

  it('falls back to the document path and its title for a reply that names no topic', () => {
    const document = parseDocument('/saved/reply.md', '# A reply heading\n\nbody', 'reply')

    expect(documentReply(document)).toEqual({
      id: 'offline:reply.md',
      url: '/saved/reply.md',
      topicTitle: 'A reply heading',
      topicUrl: '/saved/reply.md',
      repliedAt: UNKNOWN_DATE,
      body: '# A reply heading\n\nbody',
      origin: 'offline',
      documentPath: '/saved/reply.md',
    })
  })

  it('gives one reply file name in two directories the same record id', () => {
    const saved = documentReply(parseDocument('/saved/reply.md', 'first body', 'reply'))
    const moved = documentReply(parseDocument('/archive/reply.md', 'second body', 'reply'))

    expect(moved.id).toBe(saved.id)
    expect(moved.documentPath).toBe('/archive/reply.md')
  })
})
