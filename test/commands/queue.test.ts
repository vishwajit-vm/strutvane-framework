/**
 * The queue in a booted app (RFC-0006 §4, §7.2, §11): `config/queue.ts` and `QUEUE_CONNECTION`,
 * the `Queue`/`Bus` facades, job discovery from `app/jobs`, and the `queue:*` commands on a
 * SQLite database file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Bus, Queue } from '../../src/facades/queue.ts'
import { defineConfig } from '../../src/foundation/config.ts'
import { DatabaseConnectionToken } from '../../src/foundation/database.ts'
import { QueueManagerToken, registerQueueDriver } from '../../src/queue/config.ts'
import { MemoryQueueDriver } from '../../src/queue/drivers/memory.ts'
import { defineJob } from '../../src/queue/job.ts'
import { createQueueTables } from '../../src/queue/tables.ts'
import { appFolder, buildApp, cleanupFolders, sourceUrl, strut, testConfig } from './helpers.ts'

afterEach(cleanupFolders)

const sqliteEnv = { DB_CONNECTION: 'sqlite', QUEUE_CONNECTION: 'database' }

/** A job file the worker discovers; it appends each run to a file in the app folder. */
function jobFile(): string {
  return `import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineJob } from '${sourceUrl('queue/job.ts')}'

export const WriteLine = defineJob({
  name: 'write-line',
  async handle(data: { line: string }) {
    if (data.line === 'fail') throw Object.assign(new Error('asked to fail'), { code: 'asked_to_fail' })
    appendFileSync(join(process.env.QUEUE_TEST_OUT ?? '.', 'out.txt'), data.line + '\\n')
  },
})
`
}

async function preparedApp(files: Readonly<Record<string, string>> = {}) {
  const base = appFolder({
    'app/jobs/write-line.ts': jobFile(),
    'database/.gitignore': '*.sqlite\n',
    ...files,
  })
  process.env['QUEUE_TEST_OUT'] = base
  const make = () => buildApp(base, { env: sqliteEnv }).app
  const app = make()
  await app.boot()
  await createQueueTables(app.make(DatabaseConnectionToken))
  return { base, make, app }
}

const WriteLine = defineJob({ name: 'write-line', async handle(_data: { line: string }) {} })

describe('the queue in an app', () => {
  it('QUEUE_CONNECTION picks the default; APP_ENV=testing alone means sync', async () => {
    const synced = buildApp(appFolder()).app
    await synced.boot()
    expect(synced.make(QueueManagerToken).defaultConnection).toBe('sync')
    await synced.shutdown()
    const database = buildApp(appFolder(), { env: sqliteEnv }).app
    await database.boot()
    expect(database.make(QueueManagerToken).defaultConnection).toBe('database')
    await database.shutdown()
  })

  it('a bad config/queue.ts stops boot with the fix', async () => {
    const unknownDriver = buildApp(appFolder(), {
      config: {
        ...testConfig,
        queue: defineConfig(() => ({ connections: { fast: { driver: 'rediss' } } })),
      },
    }).app
    await expect(unknownDriver.boot()).rejects.toMatchObject({ code: 'queue_driver_unknown' })
    const badDefault = buildApp(appFolder(), {
      config: { ...testConfig, queue: defineConfig(() => ({ default: 'nope' })) },
    }).app
    await expect(badDefault.boot()).rejects.toMatchObject({ code: 'queue_connection_unknown' })
  })

  it('an add-on driver registered by a provider can be named in config/queue.ts', async () => {
    const app = buildApp(appFolder(), {
      config: {
        ...testConfig,
        queue: defineConfig(() => ({
          default: 'fast',
          connections: { fast: { driver: 'custom', retryAfter: 120 } },
        })),
      },
    }).app
    registerQueueDriver(app.container, 'custom', (config) => {
      expect(config.retryAfter).toBe(120)
      return new MemoryQueueDriver({ retryAfter: 120 })
    })
    await app.boot()
    await app.run(async () => {
      await Queue.push(WriteLine.with({ line: 'x' }))
      expect(await Queue.size()).toBe(1)
      expect(await Queue.size('other')).toBe(0)
      expect(await Queue.size('default', 'sync')).toBe(0)
    })
    await app.shutdown()
  })

  it('the facades dispatch through the app; Bus.dispatchSync runs at once', async () => {
    const { app } = await preparedApp()
    let ran = 0
    const Count = defineJob({
      name: 'count-sync',
      async handle(_data: unknown) {
        ran++
      },
    })
    await app.run(async () => {
      await Bus.dispatch(WriteLine.with({ line: 'a' }))
      await Queue.later(60, WriteLine.with({ line: 'b' }))
      await Bus.chain([WriteLine.with({ line: 'c' })]).dispatch()
      await Bus.dispatchSync(Count.with({}))
      expect(await Queue.size()).toBe(3)
      expect(Queue.manager()).toBe(app.make(QueueManagerToken))
    })
    expect(ran).toBe(1)
    await app.shutdown()
  })
})

describe('queue commands', () => {
  it('queue:table writes the migration once; --force writes another', async () => {
    const base = appFolder()
    const first = await strut(['queue:table', '--json'], { cwd: base })
    expect(first.code).toBe(0)
    const folder = join(base, 'database', 'migrations')
    const [file] = readdirSync(folder)
    expect(file).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_queue_tables\.ts$/)
    const text = readFileSync(join(folder, file ?? ''), 'utf8')
    expect(text).toContain("schema.create('jobs'")
    expect(text).toContain("schema.create('failed_jobs'")
    expect(text).toContain("schema.create('queue_locks'")
    const again = await strut(['queue:table', '--json'], { cwd: base })
    expect(again.code).toBe(4)
    expect(again.json().error?.code).toBe('migration_exists')
  })

  it('queue:work runs discovered jobs; failures land in queue:failed; retry and forget them', async () => {
    const { base, make, app } = await preparedApp()
    await app.run(async () => {
      await WriteLine.dispatch({ line: 'one' })
      await WriteLine.dispatch({ line: 'fail' })
      await WriteLine.dispatch({ line: 'two' })
    })
    await app.shutdown()
    const worked = await strut(['queue:work', '--stop-when-empty', '--json'], {
      cwd: base,
      app: make,
    })
    expect(worked.code).toBe(0)
    expect(worked.json().data).toMatchObject({ reason: 'empty', processed: 3 })
    expect(readFileSync(join(base, 'out.txt'), 'utf8')).toBe('one\ntwo\n')
    const failed = await strut(['queue:failed', '--json'], { cwd: base, app: make })
    const records = failed.json().data as { id: string; job: string; error: { code: string } }[]
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ job: 'write-line', error: { code: 'asked_to_fail' } })
    expect(JSON.stringify(records)).not.toContain('payload')
    const id = records[0]?.id ?? ''
    const retried = await strut(['queue:retry', id, 'missing-id', '--json'], {
      cwd: base,
      app: make,
    })
    expect(retried.code).toBe(1)
    expect(retried.json().data).toEqual({ retried: [id], missing: ['missing-id'] })
    const forgot = await strut(['queue:forget', id, '--json'], { cwd: base, app: make })
    expect(forgot.json().data).toEqual({ id, removed: false })
    expect(forgot.code).toBe(1)
  })

  it('queue:flush and queue:clear are guarded in production', async () => {
    const { base, make, app } = await preparedApp()
    await app.run(() => WriteLine.dispatch({ line: 'waiting' }))
    await app.shutdown()
    const refused = await strut(['queue:clear', '--json'], {
      cwd: base,
      app: make,
      env: { APP_ENV: 'production' },
    })
    expect(refused.json().error?.code).toBe('production_guard')
    const cleared = await strut(['queue:clear', 'database', '--queue=default', '--json'], {
      cwd: base,
      app: make,
    })
    expect(cleared.json().data).toEqual({ connection: 'database', queue: 'default', deleted: 1 })
    const flushed = await strut(['queue:flush', '--hours=1', '--json'], { cwd: base, app: make })
    expect(flushed.json().data).toEqual({ deleted: 0 })
    const bad = await strut(['queue:flush', '--hours=soon', '--json'], { cwd: base, app: make })
    expect(bad.json().error?.code).toBe('invalid_flag')
  })

  it('queue:prune-batches and queue:prune-outbox keep recent rows', async () => {
    const { base, make, app } = await preparedApp()
    await app.run(async () => {
      await Bus.batch([WriteLine.with({ line: 'b' })]).dispatch()
      await WriteLine.dispatch({ line: 'o' }, { viaOutbox: true })
    })
    await app.shutdown()
    const batches = await strut(['queue:prune-batches', '--json'], { cwd: base, app: make })
    expect(batches.json().data).toEqual({ deleted: 0 })
    const outbox = await strut(['queue:prune-outbox', '--hours=0', '--json'], {
      cwd: base,
      app: make,
    })
    expect(outbox.json().data).toEqual({ deleted: 0 })
    const worked = await strut(['queue:work', '--stop-when-empty', '--json'], {
      cwd: base,
      app: make,
    })
    expect(worked.json().data).toMatchObject({ reason: 'empty', processed: 2 })
    expect(readFileSync(join(base, 'out.txt'), 'utf8').split('\n').sort()).toEqual(['', 'b', 'o'])
  })

  it('queue:restart stops a running worker after its current job', async () => {
    const { base, make, app } = await preparedApp()
    await app.run(() => WriteLine.dispatch({ line: 'before-restart' }))
    await app.shutdown()
    const restarted = await strut(['queue:restart', '--json'], { cwd: base, app: make })
    expect(restarted.code).toBe(0)
    // The restart time is older than a worker that starts now, so that worker keeps going.
    const worked = await strut(['queue:work', '--stop-when-empty', '--json'], {
      cwd: base,
      app: make,
    })
    expect(worked.json().data).toMatchObject({ reason: 'empty' })
  })

  it('queue:work names an unknown connection with a suggestion', async () => {
    const { base, make, app } = await preparedApp()
    await app.shutdown()
    const result = await strut(['queue:work', 'databse', '--json'], { cwd: base, app: make })
    expect(result.code).toBe(3)
    expect(result.json().error?.code).toBe('queue_connection_unknown')
    expect(existsSync(join(base, 'out.txt'))).toBe(false)
  })
})
