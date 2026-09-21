/**
 * URL builder tests: every origin constant, optional-parameter branch, and the
 * quote endpoint's JSON-encoded code list.
 */

import { describe, expect, it } from 'vitest'
import { followsUrl, homeUrl, isLoginUrl, moreRepliesUrl, moreTopicUrl, realHQUrl, topicUrl } from '../src/sites.ts'

describe('URL builders', () => {
  it('builds the topic list URL with and without the sort flag', () => {
    expect(moreTopicUrl(905478, 3).href).toBe('https://www.tgb.cn/user/blog/moreTopic?userID=905478&pageNo=3')
    expect(moreTopicUrl(905478, 3, 'R').href).toBe('https://www.tgb.cn/user/blog/moreTopic?userID=905478&pageNo=3&sortFlag=R')
  })

  it('builds the reply list URL with and without the date filter', () => {
    expect(moreRepliesUrl(905478, 2).href).toBe('https://www.tgb.cn/user/blog/moreReplyMod?userID=905478&pageNo=2')
    expect(moreRepliesUrl(905478, 2, '2026-03-30').href).toBe('https://www.tgb.cn/user/blog/moreReplyMod?userID=905478&pageNo=2&time=2026-03-30')
  })

  it('builds the topic, login, follows, and home URLs', () => {
    expect(topicUrl('1ykHx9mgs4W').href).toBe('https://www.tgb.cn/a/1ykHx9mgs4W')
    expect(isLoginUrl().href).toBe('https://www.tgb.cn/user/getIsLogin')
    expect(followsUrl(905478, 1).href).toBe('https://shuo.tgb.cn/shuo/getUserBlogShuoFollow?userID=905478&pageNo=1')
    expect(homeUrl().href).toBe('https://www.tgb.cn/')
  })

  it('JSON-encodes the quote endpoint code list', () => {
    expect(realHQUrl(['sh600448', 'sz001216']).href)
      .toBe('https://hq.tgb.cn/tgb/realHQList?stockCodeList=%5B%22sh600448%22%2C%22sz001216%22%5D')
  })
})
