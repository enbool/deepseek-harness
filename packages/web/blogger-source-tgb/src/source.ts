/**
 * The tgb.cn implementation of the blogger source contract. It maps the site's
 * topic-list, topic-content, and reply-list pages onto the seam's post and reply
 * vocabulary, delegating every request to the shared {@link TgbClient} so the
 * credential, redirect, timeout, and size rules stay in one place.
 * @module @deepseek-ai/dsh-blogger-source-tgb/source
 */

import { BLOGGER_REFERENCE_INVALID, BloggerError } from '@deepseek-ai/dsh-blogger'
import type {
  BloggerListRequest,
  BloggerPage,
  BloggerPost,
  BloggerPostSummary,
  BloggerRef,
  BloggerReply,
  BloggerSource,
} from '@deepseek-ai/dsh-blogger'
import {
  moreRepliesUrl,
  moreTopicUrl,
  parseRepliesPage,
  parseTopicContentPage,
  parseTopicsPage,
  topicUrl,
} from '@deepseek-ai/dsh-tool-tgb'
import type { ReplyItem, TgbClient, TopicSummary } from '@deepseek-ai/dsh-tool-tgb'
import { parseTgbReference } from './reference.ts'

/** The registry id this source registers under. */
export const TGB_SOURCE_ID = 'tgb'

/** The platform name the source reports in model-facing and diagnostic text. */
export const TGB_SOURCE_DISPLAY_NAME = '淘股吧 (tgb.cn)'

/** The tgb.cn blogger source. */
export class TgbBloggerSource implements BloggerSource {
  readonly id = TGB_SOURCE_ID
  readonly displayName = TGB_SOURCE_DISPLAY_NAME

  /**
   * @param client - the shared tgb.cn request path, built from the plugin config.
   */
  constructor(private readonly client: TgbClient) {}

  /**
   * @param input - the caller's raw user reference.
   * @returns true when the reference is a numeric id or a tgb.cn `/blog/{id}` URL.
   */
  matches(input: string): boolean {
    return parseTgbReference(input) !== undefined
  }

  /**
   * Canonicalize a bare `userID:` string. The display name stays unset: the site
   * exposes it on the activity pages, not on the profile URL.
   *
   * @param input - the caller's raw user reference.
   * @param _signal - unused: the reference parses without a network request.
   * @returns the resolved identity.
   */
  resolve(input: string, _signal: AbortSignal): Promise<BloggerRef> {
    const parsed = parseTgbReference(input)
    if (parsed === undefined) {
      return Promise.reject(new BloggerError(
        `"${input}" is not a tgb.cn user reference; pass the numeric user id or a https://www.tgb.cn/blog/{id} URL`,
        BLOGGER_REFERENCE_INVALID,
      ))
    }
    return Promise.resolve({
      source: this.id,
      userID: String(parsed.userID),
      profileUrl: parsed.profileUrl,
    })
  }

  /**
   * @param ref - an identity this source resolved.
   * @param request - the start page, page budget, and cancellation signal.
   * @returns this blogger's topics as post summaries.
   */
  async listPosts(ref: BloggerRef, request: BloggerListRequest): Promise<BloggerPage<BloggerPostSummary>> {
    const userID = Number(ref.userID)
    const batch = await this.client.collectPages({
      build: page => moreTopicUrl(userID, request.pageNo + page - 1),
      fetchPage: async (url, signal) => parseTopicsPage(await this.client.fetchPage(url, signal)),
      idOf: topic => topic.topicID,
      maxPages: request.maxPages,
      signal: request.signal,
    })
    return {
      items: batch.items.map(toPostSummary),
      pageNo: request.pageNo,
      pagesFetched: batch.pagesFetched,
      hasMore: batch.hasMore,
    }
  }

  /**
   * @param _ref - the identity this source resolved; the post id alone locates the page.
   * @param postId - a post id this source reported from {@link TgbBloggerSource.listPosts}.
   * @param signal - cancellation signal.
   * @returns the post with its body as markdown.
   */
  async fetchPost(_ref: BloggerRef, postId: string, signal: AbortSignal): Promise<BloggerPost> {
    const page = await this.client.fetchPage(topicUrl(postId), signal)
    const content = parseTopicContentPage(page, postId)
    return {
      id: content.code,
      url: content.url,
      title: content.title,
      publishedAt: content.publishDate,
      replies: content.replies,
      views: content.views,
      bodyMarkdown: content.contentMarkdown,
    }
  }

  /**
   * @param ref - an identity this source resolved.
   * @param request - the start page, page budget, and cancellation signal.
   * @returns this blogger's replies on other users' topics.
   */
  async listReplies(ref: BloggerRef, request: BloggerListRequest): Promise<BloggerPage<BloggerReply>> {
    const userID = Number(ref.userID)
    const batch = await this.client.collectPages({
      build: page => moreRepliesUrl(userID, request.pageNo + page - 1),
      fetchPage: async (url, signal) => parseRepliesPage(await this.client.fetchPage(url, signal)),
      idOf: reply => `${reply.sourceCode}/${reply.replyId}`,
      maxPages: request.maxPages,
      signal: request.signal,
    })
    return {
      items: batch.items.map(toReply),
      pageNo: request.pageNo,
      pagesFetched: batch.pagesFetched,
      hasMore: batch.hasMore,
    }
  }
}

/**
 * Map one site topic row onto a post summary. The row's short code is the post
 * id, because it is what the topic URL and {@link TgbBloggerSource.fetchPost} take.
 *
 * @param topic - the parsed topic-list row.
 * @returns the post summary.
 */
function toPostSummary(topic: TopicSummary): BloggerPostSummary {
  return {
    id: topic.code,
    url: topic.url,
    title: topic.title,
    publishedAt: topic.publishDate,
    replies: topic.replies,
    views: topic.views,
    likes: topic.likes,
  }
}

/**
 * Map one site reply row onto a seam reply.
 *
 * @param reply - the parsed reply-list row.
 * @returns the seam reply.
 */
function toReply(reply: ReplyItem): BloggerReply {
  return {
    id: `${reply.sourceCode}/${reply.replyId}`,
    url: reply.replyUrl,
    topicTitle: reply.sourceTitle,
    topicUrl: reply.sourceUrl,
    repliedAt: reply.replyTime,
    body: reply.content,
    likes: reply.likes,
  }
}
