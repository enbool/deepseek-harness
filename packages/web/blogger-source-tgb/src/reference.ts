/**
 * Recognition and validation of the user references the tgb.cn source accepts:
 * a bare numeric user id, or a tgb.cn profile URL whose path is `/blog/{id}`.
 * The site's `sso`, `shuo`, and `hq` sub-domains share the `tgb.cn` suffix, so a
 * profile link copied from any of them is accepted and canonicalized to
 * `www.tgb.cn`.
 * @module @deepseek-ai/dsh-blogger-source-tgb/reference
 */

/** A tgb.cn user reference parsed from caller input. */
export interface TgbReference {
  /** The numeric tgb.cn user id. */
  readonly userID: number
  /** The canonical `www.tgb.cn` profile page URL. */
  readonly profileUrl: string
}

/** The bare site host. */
const TGB_HOST = 'tgb.cn'

/** The suffix every tgb.cn sub-domain carries. */
const TGB_HOST_SUFFIX = '.tgb.cn'

/** A bare numeric user id, which is the site's own user-id syntax. */
const NUMERIC_ID = /^\d+$/u

/** The profile path the site serves for one user id. */
const PROFILE_PATH = /^\/blog\/(\d+)\/?$/u

/**
 * Parse one caller reference.
 *
 * @param input - the caller's raw user reference.
 * @returns the parsed reference, or `undefined` when it is not a tgb.cn user reference.
 */
export function parseTgbReference(input: string): TgbReference | undefined {
  const text = input.trim()
  if (NUMERIC_ID.test(text)) return reference(Number(text))
  const url = parseUrl(text)
  if (url === undefined) return undefined
  if (url.hostname !== TGB_HOST && !url.hostname.endsWith(TGB_HOST_SUFFIX)) return undefined
  const match = PROFILE_PATH.exec(url.pathname)
  return match?.[1] === undefined ? undefined : reference(Number(match[1]))
}

/**
 * Build the canonical reference for one numeric user id. The id must be a safe
 * integer: anything larger is outside the site's id space and would be sent as a
 * rounded `userID` query value.
 *
 * @param userID - the numeric user id.
 * @returns the canonical reference, or `undefined` when the id is not a safe integer.
 */
function reference(userID: number): TgbReference | undefined {
  if (!Number.isSafeInteger(userID) || userID <= 0) return undefined
  return { userID, profileUrl: `https://www.tgb.cn/blog/${userID}` }
}

/**
 * Parse an absolute HTTP(S) URL without throwing.
 *
 * @param text - the raw reference text.
 * @returns the parsed URL, or `undefined` when it is not an absolute HTTP(S) URL.
 */
function parseUrl(text: string): URL | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    // A bare id or free text is not a URL; the caller's grammar rejects it.
    return undefined
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
}
