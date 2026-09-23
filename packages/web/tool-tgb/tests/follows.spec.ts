/**
 * Parser tests for the shuo.tgb.cn JSON endpoints (follow list, login state),
 * over the recorded fixture and inline payloads for the invalid-shape branches.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseFollowsPage, parseLoginState } from '../src/follows.ts'
import { expectTgbError } from './helpers.ts'

const fixture: unknown = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/follows.json', import.meta.url)), 'utf8'))

describe('parseFollowsPage over the recorded fixture', () => {
  const page = parseFollowsPage(fixture)

  it('parses the owner counters', () => {
    expect(page.followNum).toBe(29)
    expect(page.fansNum).toBe(3)
  })

  it('parses the followed users', () => {
    expect(page.list.length).toBeGreaterThan(5)
    expect(page.list[0]).toEqual({
      userID: 5727139,
      userName: 'A拉神灯',
      portrait: '2024/08/26/xh4f13m3fys7.jpg',
      gender: 'M',
      fansNum: 220224,
      followNum: 33,
      usefulNum: 405625,
      bestBBSNums: 14,
      createDate: '2025-12-16T10:45:49.000+00:00',
    })
  })

  it('fills absent string facts with empty defaults', () => {
    const entry = { userID: 7, fansNum: 0, followNum: 0, usefulNum: 0, bestBBSNums: 0 }
    const page = parseFollowsPage({ status: true, dto: { followNum: 1, fansNum: 0, list: [entry] } })
    expect(page.list[0]).toEqual({
      userID: 7, userName: '', portrait: '', gender: '', fansNum: 0, followNum: 0, usefulNum: 0, bestBBSNums: 0, createDate: '',
    })
  })
})

describe('parseFollowsPage invalid shapes', () => {
  it('fails loud on a non-object answer', () => {
    expectTgbError(() => parseFollowsPage('nope'), 'TGB_UPSTREAM_INVALID', /not an object/)
  })

  it('fails loud on status false', () => {
    expectTgbError(() => parseFollowsPage({ status: false }), 'TGB_UPSTREAM_INVALID', /status: false/)
  })

  it('fails loud on a missing dto', () => {
    expectTgbError(() => parseFollowsPage({ status: true }), 'TGB_UPSTREAM_INVALID', /no dto object/)
  })

  it('fails loud on a missing list', () => {
    expectTgbError(() => parseFollowsPage({ status: true, dto: { followNum: 1, fansNum: 1 } }), 'TGB_UPSTREAM_INVALID', /no list array/)
  })

  it('fails loud when counters or entries are the wrong type', () => {
    expectTgbError(() => parseFollowsPage({ status: true, dto: { followNum: 'x', fansNum: 1, list: [] } }), 'TGB_UPSTREAM_INVALID', /followNum/)
    expectTgbError(() => parseFollowsPage({ status: true, dto: { followNum: 1, fansNum: 1, list: [null] } }), 'TGB_UPSTREAM_INVALID', /entry 0/)
    expectTgbError(() => parseFollowsPage({ status: true, dto: { followNum: 1, fansNum: 1, list: [{ userID: 'x' }] } }), 'TGB_UPSTREAM_INVALID', /userID/)
  })
})

describe('parseLoginState', () => {
  it('parses the logged-in user', () => {
    expect(parseLoginState({ status: true, dto: { userID: 905478, userName: 'enbool', portrait: 'p' } }))
      .toEqual({ userID: 905478, userName: 'enbool' })
  })

  it('fails loud on status false or a missing name', () => {
    expectTgbError(() => parseLoginState({ status: false, dto: {} }), 'TGB_AUTH_REQUIRED', /status: false/)
    expectTgbError(() => parseLoginState({ status: true, dto: { userID: 1 } }), 'TGB_AUTH_REQUIRED', /no userName/)
  })

  it('fails loud on shapes it cannot trust', () => {
    expectTgbError(() => parseLoginState('nope'), 'TGB_UPSTREAM_INVALID', /not an object/)
    expectTgbError(() => parseLoginState({ status: true }), 'TGB_UPSTREAM_INVALID', /no dto object/)
  })
})
