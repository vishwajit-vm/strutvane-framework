/**
 * The queue commands (RFC-0006 §4, §7.2):
 *
 * | Command | Does |
 * |---|---|
 * | `queue:table [--force]` | write the migration for `jobs`, `failed_jobs` and `queue_locks` |
 * | `queue:work [connection] [--queue=high,default] …` | run a worker until stopped |
 * | `queue:restart` | ask every worker to stop after its current job (deploys) |
 * | `queue:failed` | list failed jobs |
 * | `queue:retry <id…\|all>` | push failed jobs again |
 * | `queue:forget <id>` | delete one failed job |
 * | `queue:flush [--hours=N]` | delete failed jobs (destructive guard) |
 * | `queue:clear [connection] [--queue=default]` | delete waiting jobs (destructive guard) |
 * | `queue:prune-batches [--hours=24]` | delete finished and cancelled batches |
 * | `queue:prune-outbox [--hours=24]` | delete dispatched outbox rows |
 *
 * @module
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CacheManagerToken } from '../../../cache/contract.ts'
import type { Application } from '../../../foundation/application.ts'
import { QueueManagerToken } from '../../../queue/config.ts'
import { discoverJobs } from '../../../queue/discover.ts'
import { isQueueError } from '../../../queue/errors.ts'
import type { QueueManager } from '../../../queue/manager.ts'
import { queueTablesMigration } from '../../../queue/tables.ts'
import { Worker, type WorkerOptions } from '../../../queue/worker.ts'
import type { AnyCommand } from '../../framework/command.ts'
import { EXIT, type ExitCode } from '../../framework/exit-codes.ts'
import { migrationFileName } from '../../make/migration-stubs.ts'
import {
  type AppCommandDeps,
  appRoot,
  BOOT_FLAGS,
  commandError,
  defineAppCommand,
  withBootedApp,
} from './support.ts'

/** The cache key `queue:restart` writes and workers read. */
export const QUEUE_RESTART_KEY = 'strutvane:queue:restart'

/**
 * What the queue commands need besides the app loader: how `queue:work` hears SIGTERM/SIGINT
 * (tests trigger it by hand).
 *
 * @example
 * const deps: QueueCommandDeps = { ...DEFAULT_APP_DEPS, onStopSignal: (stop) => { … ; return () => {} } }
 */
export interface QueueCommandDeps extends AppCommandDeps {
  /** Call `stop` on the first SIGTERM/SIGINT; returns the "stop listening" function. */
  readonly onStopSignal?: (stop: () => void) => () => void
}

function processSignals(stop: () => void): () => void {
  let stopping = false
  const handler = (signal: NodeJS.Signals): void => {
    // The second signal means "now": the running job is not acknowledged, so it comes back.
    if (stopping) process.exit(signal === 'SIGINT' ? 130 : 143)
    stopping = true
    stop()
  }
  process.on('SIGTERM', handler)
  process.on('SIGINT', handler)
  return () => {
    process.off('SIGTERM', handler)
    process.off('SIGINT', handler)
  }
}

function managerOf(app: Application): QueueManager {
  return app.make(QueueManagerToken)
}

function wholeNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d{1,9}$/.test(value))
    throw commandError(
      'invalid_flag',
      `--${flag} must be a whole number; got "${value}".`,
      `Pass --${flag}=60.`,
      EXIT.USAGE,
    )
  return Number(value)
}

/** Turn a queue error into a CLI failure with its code and hint. */
async function friendly<TResult>(work: () => Promise<TResult>): Promise<TResult> {
  try {
    return await work()
  } catch (error) {
    if (isQueueError(error))
      throw commandError(error.code, error.message, error.hint, EXIT.VALIDATION)
    throw error
  }
}

const WORK_FLAGS = {
  queue: { type: 'string', valueName: '<a,b>', description: 'Queues in priority order' },
  sleep: {
    type: 'string',
    valueName: '<s>',
    description: 'Seconds to sleep when idle (default 3)',
  },
  timeout: { type: 'string', valueName: '<s>', description: 'Override every job timeout' },
  memory: {
    type: 'string',
    valueName: '<mb>',
    description: 'Stop above this memory (default 512)',
  },
  'max-jobs': { type: 'string', valueName: '<n>', description: 'Stop after n jobs' },
  'max-time': { type: 'string', valueName: '<s>', description: 'Stop after s seconds' },
  rest: { type: 'string', valueName: '<s>', description: 'Seconds to rest between jobs' },
  'stop-when-empty': { type: 'boolean', description: 'Stop once every queue is empty' },
} as const

/**
 * The queue commands.
 *
 * @example
 * queueCommands(DEFAULT_APP_DEPS)
 */
export function queueCommands(deps: QueueCommandDeps): readonly AnyCommand[] {
  return [
    defineAppCommand({
      name: 'queue:table',
      description: 'Create the migration for the queue tables',
      details: 'Writes database/migrations/<timestamp>_create_queue_tables.ts; run migrate next.',
      requiresProject: false,
      flags: { force: { type: 'boolean', description: 'Write it even if one exists' } },
      examples: ['node strut queue:table && node strut migrate'],
      run(ctx) {
        const root = appRoot(ctx)
        const folder = join(root, 'database', 'migrations')
        const existing = existsSync(folder)
          ? readdirSync(folder).find((file) => file.endsWith('_create_queue_tables.ts'))
          : undefined
        if (existing !== undefined && ctx.flags.force !== true)
          throw commandError(
            'migration_exists',
            `database/migrations/${existing} already creates the queue tables.`,
            'Run node strut migrate, or pass --force to write another one.',
            EXIT.CONFLICT,
          )
        mkdirSync(folder, { recursive: true })
        const name = migrationFileName('create_queue_tables', new Date())
        writeFileSync(join(folder, name), queueTablesMigration(), { flag: 'wx' })
        ctx.out.success(`Created database/migrations/${name}.`)
        ctx.out.info('Run node strut migrate to create the tables.')
        return { data: { file: `database/migrations/${name}` } }
      },
    }),
    defineAppCommand({
      name: 'queue:work',
      description: 'Process queued jobs until stopped',
      details:
        'Stops gracefully on SIGTERM/SIGINT (the running job finishes first), on queue:restart, and at the memory, job and time limits. Run it under a supervisor (systemd, Docker, PM2) that restarts it.',
      requiresProject: false,
      args: { connection: { description: 'The connection (default: QUEUE_CONNECTION)' } },
      flags: { ...BOOT_FLAGS, ...WORK_FLAGS },
      examples: [
        'node strut queue:work',
        'node strut queue:work database --queue=high,default --max-time=3600',
      ],
      async run(ctx) {
        return withBootedApp(ctx, deps, (app) =>
          friendly(async () => {
            const manager = managerOf(app)
            const files = await discoverJobs(app.basePath, manager.jobs)
            const options: WorkerOptions = {
              ...(ctx.args.connection === undefined ? {} : { connection: ctx.args.connection }),
              ...(ctx.flags.queue === undefined
                ? {}
                : { queues: ctx.flags.queue.split(',').map((queue) => queue.trim()) }),
              ...numeric('sleep', wholeNumber(ctx.flags.sleep, 'sleep')),
              ...numeric('timeout', wholeNumber(ctx.flags.timeout, 'timeout')),
              ...numeric('memory', wholeNumber(ctx.flags.memory, 'memory')),
              ...numeric('maxJobs', wholeNumber(ctx.flags['max-jobs'], 'max-jobs')),
              ...numeric('maxTime', wholeNumber(ctx.flags['max-time'], 'max-time')),
              ...numeric('rest', wholeNumber(ctx.flags.rest, 'rest')),
              stopWhenEmpty: ctx.flags['stop-when-empty'] === true,
              restartSignal: async () => {
                if (!app.container.has(CacheManagerToken)) return undefined
                const at = await app.make(CacheManagerToken).store().get(QUEUE_RESTART_KEY)
                return typeof at === 'number' ? at : undefined
              },
            }
            const worker = new Worker(manager, options)
            const stopListening = manager.listen((event) => {
              if (event.type === 'queue.job.processed')
                ctx.out.line(
                  `  ✓ ${event.job ?? '?'} ${event.jobId ?? ''} (${event.durationMs ?? 0} ms)`,
                )
              else if (event.type === 'queue.job.failed')
                ctx.out.line(
                  `  ✗ ${event.job ?? '?'} ${event.jobId ?? ''} failed: ${event.errorCode ?? ''}`,
                )
              else if (event.type === 'queue.job.released')
                ctx.out.line(
                  `  ↻ ${event.job ?? '?'} ${event.jobId ?? ''} retry in ${event.delaySeconds ?? 0}s`,
                )
            })
            const stopSignals = (deps.onStopSignal ?? processSignals)(() => {
              ctx.out.info('Stopping after the current job…')
              worker.stop()
            })
            ctx.out.info(
              `Processing ${worker.queues.join(', ')} on "${manager.connection(options.connection).name}" (${manager.jobs.names().length} job types from ${files.length} files).`,
            )
            try {
              const result = await worker.run()
              ctx.out.info(`Worker stopped (${result.reason}) after ${result.processed} job(s).`)
              return { data: result, exitCode: result.code as ExitCode }
            } finally {
              stopSignals()
              stopListening()
            }
          }),
        )
      },
    }),
    defineAppCommand({
      name: 'queue:restart',
      description: 'Ask every worker to stop after its current job',
      details: 'Workers check the default cache store between jobs; run it after each deploy.',
      requiresProject: false,
      flags: { ...BOOT_FLAGS },
      async run(ctx) {
        const at = await withBootedApp(ctx, deps, async (app) => {
          const now = Date.now()
          await app.make(CacheManagerToken).store().put(QUEUE_RESTART_KEY, now)
          return now
        })
        ctx.out.success('Workers will restart after their current job.')
        return { data: { restartAt: at } }
      },
    }),
    defineAppCommand({
      name: 'queue:failed',
      description: 'List failed jobs',
      requiresProject: false,
      flags: { ...BOOT_FLAGS },
      async run(ctx) {
        const records = await withBootedApp(ctx, deps, (app) => managerOf(app).failed.all())
        if (records.length === 0) ctx.out.line('  No failed jobs.')
        else
          ctx.out.table(
            ['ID', 'Connection', 'Queue', 'Job', 'Failed at', 'Error'],
            records.map((record) => [
              record.id,
              record.connection,
              record.queue,
              record.job,
              new Date(record.failedAt).toISOString(),
              record.error.code ?? record.error.message.slice(0, 60),
            ]),
          )
        return {
          data: records.map((record) => ({
            ...record,
            payload: undefined,
            failedAt: record.failedAt,
          })),
        }
      },
    }),
    defineAppCommand({
      name: 'queue:retry',
      description: 'Push failed jobs onto their queue again',
      requiresProject: false,
      args: { ids: { required: true, variadic: true, description: 'Failed job ids, or "all"' } },
      flags: { ...BOOT_FLAGS },
      examples: ['node strut queue:retry 0193…', 'node strut queue:retry all'],
      async run(ctx) {
        const result = await withBootedApp(ctx, deps, (app) =>
          friendly(async () => {
            const manager = managerOf(app)
            await discoverJobs(app.basePath, manager.jobs)
            const ids =
              ctx.args.ids.length === 1 && ctx.args.ids[0] === 'all'
                ? (await manager.failed.all(10_000)).map((record) => record.id)
                : ctx.args.ids
            const retried: string[] = []
            const missing: string[] = []
            for (const id of ids) ((await manager.retryFailed(id)) ? retried : missing).push(id)
            return { retried, missing }
          }),
        )
        for (const id of result.retried) ctx.out.success(`Pushed ${id} again.`)
        for (const id of result.missing) ctx.out.warn(`No failed job ${id}.`)
        return {
          data: result,
          ...(result.missing.length > 0 ? { exitCode: EXIT.FAILURE } : {}),
        }
      },
    }),
    defineAppCommand({
      name: 'queue:forget',
      description: 'Delete one failed job',
      requiresProject: false,
      args: { id: { required: true, description: 'The failed job id' } },
      flags: { ...BOOT_FLAGS },
      async run(ctx) {
        const removed = await withBootedApp(ctx, deps, (app) =>
          managerOf(app).failed.forget(ctx.args.id),
        )
        if (removed) ctx.out.success(`Deleted failed job ${ctx.args.id}.`)
        else ctx.out.warn(`No failed job ${ctx.args.id}.`)
        return {
          data: { id: ctx.args.id, removed },
          ...(removed ? {} : { exitCode: EXIT.FAILURE }),
        }
      },
    }),
    defineAppCommand({
      name: 'queue:flush',
      description: 'Delete failed jobs',
      details:
        'Unless APP_ENV is local, test, testing or development this needs --force --i-understand.',
      requiresProject: false,
      flags: {
        ...BOOT_FLAGS,
        hours: { type: 'string', valueName: '<n>', description: 'Only those older than n hours' },
      },
      async run(ctx) {
        ctx.guardDestructive()
        const hours = wholeNumber(ctx.flags.hours, 'hours')
        const count = await withBootedApp(ctx, deps, (app) =>
          managerOf(app).failed.flush(
            hours === undefined ? undefined : Date.now() - hours * 3_600_000,
          ),
        )
        ctx.out.success(`Deleted ${count} failed job(s).`)
        return { data: { deleted: count } }
      },
    }),
    defineAppCommand({
      name: 'queue:clear',
      description: 'Delete the waiting jobs of a queue',
      details:
        'Unless APP_ENV is local, test, testing or development this needs --force --i-understand.',
      requiresProject: false,
      args: { connection: { description: 'The connection (default: QUEUE_CONNECTION)' } },
      flags: {
        ...BOOT_FLAGS,
        queue: { type: 'string', valueName: '<name>', description: 'The queue (default: default)' },
      },
      async run(ctx) {
        ctx.guardDestructive()
        const result = await withBootedApp(ctx, deps, (app) =>
          friendly(async () => {
            const connection = managerOf(app).connection(ctx.args.connection)
            const queue = ctx.flags.queue ?? connection.defaultQueue
            if (connection.driver === undefined)
              return { connection: connection.name, queue, deleted: 0 }
            return {
              connection: connection.name,
              queue,
              deleted: await connection.driver.clear(queue),
            }
          }),
        )
        ctx.out.success(
          `Deleted ${result.deleted} job(s) from "${result.queue}" on "${result.connection}".`,
        )
        return { data: result }
      },
    }),
    pruneCommand(
      deps,
      'queue:prune-batches',
      'Delete finished and cancelled batches',
      (m, before) => m.pruneBatches(before),
    ),
    pruneCommand(deps, 'queue:prune-outbox', 'Delete dispatched outbox rows', (m, before) =>
      m.pruneOutbox(before),
    ),
  ]
}

function pruneCommand(
  deps: QueueCommandDeps,
  name: string,
  description: string,
  prune: (manager: QueueManager, beforeMs: number) => Promise<number>,
): AnyCommand {
  return defineAppCommand({
    name,
    description,
    details: 'Keeps the last 24 hours unless --hours says otherwise. Schedule it daily.',
    requiresProject: false,
    flags: {
      ...BOOT_FLAGS,
      hours: {
        type: 'string',
        valueName: '<n>',
        description: 'Keep the last n hours (default 24)',
      },
    },
    async run(ctx) {
      const hours = wholeNumber(ctx.flags.hours, 'hours') ?? 24
      const deleted = await withBootedApp(ctx, deps, (app) =>
        friendly(() => prune(managerOf(app), Date.now() - hours * 3_600_000)),
      )
      ctx.out.success(`Deleted ${deleted} row(s) older than ${hours} hour(s).`)
      return { data: { deleted } }
    },
  })
}

function numeric<TKey extends string>(
  key: TKey,
  value: number | undefined,
): Partial<Record<TKey, number>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<TKey, number>>)
}
