/**
 * Reference grammar for the tgb.cn source: the numeric user id and the
 * `/blog/{id}` profile URL, plus every near-miss the grammar rejects.
 */

import { describe, expect, it } from 'vitest'
import { parseTgbReference } from '@deepseek-ai/dsh-blogger-source-tgb'

describe('parseTgbReference', () => {
  it.each([
    ['905478', 905478],
    ['  905478  ', 905478],
    ['https://www.tgb.cn/blog/905478', 905478],
    ['http://www.tgb.cn/blog/905478/', 905478],
    ['https://tgb.cn/blog/905478', 905478],
    ['https://shuo.tgb.cn/blog/905478?from=home#top', 905478],
  ])('canonicalizes %s', (input, userID) => {
    expect(parseTgbReference(input)).toEqual({
      userID,
      profileUrl: `https://www.tgb.cn/blog/${userID}`,
    })
  })

  it.each([
    ['', 'empty text'],
    ['enbool', 'a display name rather than an id'],
    ['https://www.tgb.cn/blog/enbool', 'a non-numeric profile path'],
    ['https://www.tgb.cn/user/905478', 'a path other than /blog/{id}'],
    ['https://example.com/blog/905478', 'a foreign host'],
    ['https://not-tgb.cn/blog/905478', 'a host that merely ends in the same letters'],
    ['ftp://www.tgb.cn/blog/905478', 'a non-HTTP protocol'],
    ['0', 'a zero id'],
    ['99999999999999999999', 'an id beyond the safe-integer range'],
  ])('rejects %s (%s)', (input) => {
    expect(parseTgbReference(input)).toBeUndefined()
  })
})
