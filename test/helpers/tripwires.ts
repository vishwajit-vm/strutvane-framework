/**
 * Process-level tripwires for `npm run test:tripwire` (vitest.tripwire.config.ts), run with
 * `--unhandled-rejections=strict`. Each test file must end with:
 * - no `uncaughtException` and no `unhandledRejection` (a floating promise or an error event
 *   without a listener somewhere in the code under test);
 * - no sockets, servers or timers left running that it started (a leak, or a missing cleanup that
 *   would keep a real process from exiting).
 * Process pipes (stdout/stderr) are allowed: they open lazily on the first log line.
 */
import { afterAll, beforeAll, expect } from 'vitest'

const hits: string[] = []
process.on('uncaughtException', (error) => {
  hits.push(`uncaughtException: ${error.stack ?? String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  hits.push(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

const LEAKS = new Set(['TCPServerWrap', 'TCPSocketWrap', 'Timeout', 'FSReqPromise', 'ProcessWrap'])
const count = (): Map<string, number> => {
  const out = new Map<string, number>()
  for (const r of process.getActiveResourcesInfo())
    if (LEAKS.has(r)) out.set(r, (out.get(r) ?? 0) + 1)
  return out
}

let before = new Map<string, number>()
beforeAll(() => {
  before = count()
})

afterAll(async () => {
  // Sockets closed by the last test finish closing on the next turns of the event loop.
  let leaked: string[] = []
  for (let i = 0; i < 40; i++) {
    leaked = [...count()]
      .filter(([type, n]) => n > (before.get(type) ?? 0))
      .map(([type, n]) => `${type} +${n - (before.get(type) ?? 0)}`)
    if (leaked.length === 0) break
    await new Promise((r) => setTimeout(r, 50))
  }
  expect(hits, 'uncaught exceptions / unhandled rejections').toEqual([])
  expect(leaked, 'resources left running by this test file').toEqual([])
})
