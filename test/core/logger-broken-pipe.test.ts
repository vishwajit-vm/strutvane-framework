/**
 * The default logger writes to the process's stdout. When the reader of that pipe goes away (a
 * log shipper restarts, `sv start | head`, a closed terminal), Node emits an asynchronous `error`
 * (EPIPE) on `process.stdout`; with no listener it is an uncaught exception that kills the app.
 * The logger promises it never breaks the host (RFC-0004, ADR-0015): records are counted as
 * dropped, one warning goes to stderr, and the app keeps running. Real child processes, real pipes.
 */
import { spawn } from 'node:child_process'
import { describe, expect, test } from 'vitest'

const loggerUrl = new URL('../../src/core/logger/logger.ts', import.meta.url).href

/** Logs for a while through the default sink, then reports how it ended. */
const CHILD = `
import { createLogger } from ${JSON.stringify(loggerUrl)}
const log = createLogger()
const until = Date.now() + 1200
const tick = () => {
  for (let i = 0; i < 50; i++) log.info('line', { i })
  if (Date.now() < until) setTimeout(tick, 5)
  else process.stderr.write('child: finished, dropped=' + log.dropped + '\\n')
}
tick()
`

function runWithClosedReader(
  closeStderr = false,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    // The reader goes away after the first line, like `| head -1`.
    child.stdout.once('data', () => {
      child.stdout.destroy()
      if (closeStderr) child.stderr.destroy()
    })
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

describe('default logger on a broken stdout pipe', () => {
  test('the process keeps running, exits normally, and warns exactly once', async () => {
    const { code, stderr } = await runWithClosedReader()
    expect(stderr).not.toMatch(/Unhandled 'error' event|EPIPE: broken pipe, write\n\s+at/)
    expect(stderr).toMatch(/child: finished, dropped=[1-9]\d*/)
    expect(stderr.match(/logger sink failed/g)?.length).toBe(1)
    expect(code).toBe(0)
  }, 30_000)

  test('stdout and stderr both gone (the warning channel too): still no crash', async () => {
    const { code } = await runWithClosedReader(true)
    expect(code).toBe(0)
  }, 30_000)
})
