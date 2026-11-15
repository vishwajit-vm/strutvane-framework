/**
 * `sv dev` and `sv build` run Node child processes. A child that cannot start emits `error`
 * (possibly without `exit`): without a listener that crashed the CLI with an uncaught error
 * event; waiting for `exit` alone could hang. The signal listeners added to forward Ctrl+C must
 * not outlive the child either.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runChild } from '../../src/commands.ts'

const before = {
  SIGINT: process.listenerCount('SIGINT'),
  SIGTERM: process.listenerCount('SIGTERM'),
}

describe('runChild', () => {
  it('resolves with the child exit code', async () => {
    expect(await runChild(['-e', 'process.exit(3)'], { cwd: process.cwd() })).toBe(3)
  })

  it('a child that cannot start (missing working directory) is exit code 1, not a crash', async () => {
    const missing = join(process.cwd(), 'no-such-directory-for-run-child')
    expect(await runChild(['-e', '0'], { cwd: missing, forwardSignals: true })).toBe(1)
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
  })

  it('signal listeners are removed once the child is gone', async () => {
    expect(await runChild(['-e', '0'], { cwd: process.cwd(), forwardSignals: true })).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
  })
})
