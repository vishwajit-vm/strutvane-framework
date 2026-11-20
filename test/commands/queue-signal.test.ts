/**
 * `node strut queue:work` in a real process (RFC-0006 §4): SIGTERM while a job runs lets that job
 * finish and be acknowledged, then the worker exits 0 and leaves the next job queued.
 *
 * POSIX only: Windows has no SIGTERM delivery (`kill()` terminates the process outright), so there
 * the same path is covered in-process through `Worker.stop()` (test/queue/worker.test.ts).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseConnectionToken } from '../../src/foundation/database.ts'
import { defineJob } from '../../src/queue/job.ts'
import { createQueueTables } from '../../src/queue/tables.ts'
import {
  appFolder,
  buildApp,
  cleanupFolders,
  ROOT,
  sourceUrl,
  testEnv,
  writeFiles,
} from './helpers.ts'

afterEach(cleanupFolders)

const env = { ...testEnv, DB_CONNECTION: 'sqlite', QUEUE_CONNECTION: 'database' }

const Slow = defineJob({ name: 'slow-write', async handle(_data: { n: number }) {} })

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

/** A real app with a slow job and two jobs queued in its SQLite database. */
async function realWorkerApp(): Promise<string> {
  const base = appFolder()
  writeFiles(base, {
    'database/.gitignore': '*.sqlite\n',
    '.env': `${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    'bootstrap/app.ts': `import { dirname } from 'node:path'
import { Application } from '${sourceUrl('foundation/application.ts')}'
import { defineConfig } from '${sourceUrl('foundation/config.ts')}'

const app = defineConfig((env) => ({
  name: 'Worker',
  env: env.string('APP_ENV', 'production'),
  debug: false,
  url: 'http://localhost',
  key: env.string('APP_KEY'),
}))

export default Application.configure({ basePath: dirname(import.meta.dirname) }).withConfig({ app }).create()
`,
    'app/jobs/slow-write.ts': `import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineJob } from '${sourceUrl('queue/job.ts')}'

export const SlowWrite = defineJob({
  name: 'slow-write',
  timeout: 30,
  async handle(data: { n: number }) {
  writeFileSync(join(${JSON.stringify(base)}, 'started-' + data.n), '')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  appendFileSync(join(${JSON.stringify(base)}, 'finished.txt'), data.n + '\\n')
  },
})
`,
  })
  const app = buildApp(base, { env }).app
  await app.boot()
  await createQueueTables(app.make(DatabaseConnectionToken))
  await app.run(async () => {
    await Slow.dispatch({ n: 1 })
    await Slow.dispatch({ n: 2 })
  })
  await app.shutdown()
  return base
}

function worker(
  base: string,
  args: readonly string[],
): { child: ChildProcess; output: () => string } {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'src', 'console', 'bin.ts'), 'queue:work', ...args],
    {
      cwd: base,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  return { child, output: () => output }
}

describe('queue:work in a real process', () => {
  it('loads the app, discovers app/jobs and works the queue empty (every OS)', async () => {
    const base = await realWorkerApp()
    const { child, output } = worker(base, ['--stop-when-empty'])
    const code = await exited(child)
    expect(code, output()).toBe(0)
    expect(readFileSync(join(base, 'finished.txt'), 'utf8')).toBe('1\n2\n')
    expect(output()).toContain('Worker stopped (empty) after 2 job(s).')
  }, 90_000)
})

describe.skipIf(process.platform === 'win32')('queue:work and SIGTERM', () => {
  it('SIGTERM drains the running job, then exits 0', async () => {
    const base = await realWorkerApp()

    const { child, output: read } = worker(base, ['--sleep=1'])
    const exit = exited(child)
    try {
      await waitFor(() => existsSync(join(base, 'started-1')), 45_000)
      child.kill('SIGTERM')
      expect(await exit).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    expect(readFileSync(join(base, 'finished.txt'), 'utf8')).toBe('1\n')
    expect(existsSync(join(base, 'started-2'))).toBe(false)
    expect(read()).toContain('Stopping after the current job')
    const after = buildApp(base, { env }).app
    await after.boot()
    const { rows } = await after
      .make(DatabaseConnectionToken)
      .run((await import('../../src/database/sql/fragment.ts')).sql`SELECT COUNT(*) AS n FROM jobs`)
    expect(Number(rows[0]?.['n'])).toBe(1)
    await after.shutdown()
  }, 90_000)
})
