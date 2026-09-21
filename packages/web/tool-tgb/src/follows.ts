/**
 * Parser for the shuo.tgb.cn JSON endpoints: the follow list (关注列表) and
 * the current login state. Both answers carry the site's `status`/`dto`
 * envelope; anything off that shape fails loud with `TGB_UPSTREAM_INVALID`,
 * and a `status: false` login answer reads as an expired login state.
 * @module @deepseek-ai/dsh-tool-tgb/follows
 */

import { TGB_AUTH_REQUIRED, TGB_UPSTREAM_INVALID, TgbError } from './errors.ts'
import type { FollowUser } from './types.ts'

/** One page of the follow list: the owner's counters plus the page's users. */
export interface FollowListPage {
  /** How many users the owner follows in total. */
  followNum: number
  /** How many fans the owner has. */
  fansNum: number
  /** The page's followed users, in site order. */
  list: FollowUser[]
}

/** The current login state, as the `getIsLogin` endpoint reports it. */
export interface LoginState {
  /** The logged-in user's id. */
  userID: number
  /** The logged-in user's display name. */
  userName: string
}

/**
 * Read one property of an unknown object as a number.
 *
 * @param payload - the envelope object.
 * @param key - the property to read.
 * @returns the number value.
 */
function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TgbError(`tgb.cn follow payload field "${key}" is not a number`, TGB_UPSTREAM_INVALID)
  }
  return value
}

/**
 * Read one property of an unknown object as a string.
 *
 * @param payload - the envelope object.
 * @param key - the property to read.
 * @param fallback - the value used when the property is absent or not a string.
 * @returns the string value.
 */
function stringField(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const value = payload[key]
  return typeof value === 'string' ? value : fallback
}

/**
 * Assert the site's `status: true` envelope and return the `dto` object.
 *
 * @param payload - the parsed endpoint answer.
 * @param endpoint - the endpoint name, for error messages.
 * @returns the `dto` object.
 */
function assertDto(payload: unknown, endpoint: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new TgbError(`tgb.cn ${endpoint} answer is not an object`, TGB_UPSTREAM_INVALID)
  }
  const record = payload as Record<string, unknown>
  if (record.status !== true) {
    throw new TgbError(`tgb.cn ${endpoint} answered status: ${String(record.status)}`, TGB_UPSTREAM_INVALID)
  }
  if (typeof record.dto !== 'object' || record.dto === null) {
    throw new TgbError(`tgb.cn ${endpoint} answer carries no dto object`, TGB_UPSTREAM_INVALID)
  }
  return record.dto as Record<string, unknown>
}

/**
 * Parse one `getUserBlogShuoFollow` answer into its counters and users.
 *
 * @param payload - the parsed JSON answer.
 * @returns the page's counters and followed users.
 */
export function parseFollowsPage(payload: unknown): FollowListPage {
  const dto = assertDto(payload, 'follow list')
  const rawList = dto.list
  if (!Array.isArray(rawList)) {
    throw new TgbError('tgb.cn follow list dto carries no list array', TGB_UPSTREAM_INVALID)
  }
  return {
    followNum: numberField(dto, 'followNum'),
    fansNum: numberField(dto, 'fansNum'),
    list: rawList.map(parseFollowUser),
  }
}

/**
 * Parse one follow-list entry.
 *
 * @param entry - the raw JSON entry.
 * @param index - the entry's position, for error messages.
 * @returns the parsed followed user.
 */
function parseFollowUser(entry: unknown, index: number): FollowUser {
  if (typeof entry !== 'object' || entry === null) {
    throw new TgbError(`tgb.cn follow list entry ${index} is not an object`, TGB_UPSTREAM_INVALID)
  }
  const record = entry as Record<string, unknown>
  return {
    userID: numberField(record, 'userID'),
    userName: stringField(record, 'userName'),
    portrait: stringField(record, 'portrait'),
    gender: stringField(record, 'gender'),
    fansNum: numberField(record, 'fansNum'),
    followNum: numberField(record, 'followNum'),
    usefulNum: numberField(record, 'usefulNum'),
    bestBBSNums: numberField(record, 'bestBBSNums'),
    createDate: stringField(record, 'createDate'),
  }
}

/**
 * Parse the `getIsLogin` answer into the current user.
 *
 * @param payload - the parsed JSON answer.
 * @returns the logged-in user's id and name.
 */
export function parseLoginState(payload: unknown): LoginState {
  if (typeof payload !== 'object' || payload === null) {
    throw new TgbError('tgb.cn login state answer is not an object', TGB_UPSTREAM_INVALID)
  }
  const record = payload as Record<string, unknown>
  // `status: false` reads as "not logged in" — the cookie's login session is
  // gone — which is an auth failure for the tool, not a parser anomaly.
  if (record.status !== true) {
    throw new TgbError(
      'tgb.cn login state answered status: false; the configured cookie credential is not logged in',
      TGB_AUTH_REQUIRED,
    )
  }
  if (typeof record.dto !== 'object' || record.dto === null) {
    throw new TgbError('tgb.cn login state answer carries no dto object', TGB_UPSTREAM_INVALID)
  }
  const dto = record.dto as Record<string, unknown>
  const userID = numberField(dto, 'userID')
  const userName = stringField(dto, 'userName')
  if (userName === '') {
    throw new TgbError('tgb.cn login state carries no userName', TGB_AUTH_REQUIRED)
  }
  return { userID, userName }
}
