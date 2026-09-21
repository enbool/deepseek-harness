/**
 * Shared test helper: assert that a call throws a {@link TgbError} with a
 * specific code and message fragment.
 */

import { expect } from 'vitest'
import { TgbError } from '../src/errors.ts'

/**
 * Assert that `call` throws a TgbError carrying `code` and a message matching
 * `message`.
 *
 * @param call - the call expected to throw.
 * @param code - the expected stable error code.
 * @param message - a fragment the message must contain.
 */
export function expectTgbError(call: () => unknown, code: string, message: RegExp): void {
  let caught: unknown
  try {
    call()
  } catch (error: unknown) {
    caught = error
  }
  expect(caught).toBeInstanceOf(TgbError)
  expect((caught as TgbError).code).toBe(code)
  expect((caught as TgbError).message).toMatch(message)
}

/**
 * Assert that a rejected promise carries a TgbError with `code`.
 *
 * @param call - the promise expected to reject.
 * @param code - the expected stable error code.
 * @param message - a fragment the message must contain.
 */
export async function expectTgbRejection(call: () => Promise<unknown>, code: string, message: RegExp): Promise<void> {
  let caught: unknown
  try {
    await call()
  } catch (error: unknown) {
    caught = error
  }
  expect(caught).toBeInstanceOf(TgbError)
  expect((caught as TgbError).code).toBe(code)
  expect((caught as TgbError).message).toMatch(message)
}
