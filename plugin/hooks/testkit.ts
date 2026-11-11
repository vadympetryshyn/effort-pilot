// Imported by the tests only, never by register.tsx: the kit's `test` with a
// per-test timeout long enough for a heavily loaded machine. A test's own
// `timeoutMs` still wins.
import { test as kitTest } from 'claude-code/testing'
import type { TestBody, TestOptions, TestRest } from 'claude-code/testing'

const TIMEOUT_MS = 30_000

export const test = (name: string, ...rest: TestRest): void => {
  const [options, body]: [TestOptions, TestBody] =
    rest.length === 1 ? [{}, rest[0]] : [rest[0], rest[1]]
  kitTest(name, { timeoutMs: TIMEOUT_MS, ...options }, body)
}
