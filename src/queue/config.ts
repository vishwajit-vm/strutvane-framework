/**
 * `config/queue.ts` and the app binding (RFC-0006 §11).
 *
 * ```ts
 * // config/queue.ts
 * export default defineConfig((env) => ({
 *   default: env.string('QUEUE_CONNECTION', 'database'),
 *   connections: {
 *     sync: { driver: 'sync' },
 *     database: { driver: 'database', table: 'jobs', queue: 'default', retryAfter: 90 },
 *   },
 *   failed: { driver: 'database', table: 'failed_jobs' },
 * }))
 * ```
 *
 * Without a config file: `QUEUE_CONNECTION` picks the connection (`sync` or `database`), and the
 * default is `sync` under `APP_ENV=testing`, else `database`. Add-on drivers (`@strutvane/redis`)
 * register a factory with {@link registerQueueDriver} in their provider; a config naming a driver
 * nobody registered stops boot with the fix.
 *
 * @module
 */
import type { Logger } from '../contracts/logger.ts'
import type { QueueDriver, QueueLockStore } from '../contracts/queue.ts'
import type { Clock } from '../core/clock.ts'
import { type Container, type Token, token } from '../core/container.ts'
import type { Connection } from '../database/db/connection.ts'
import { closestMatch } from '../support/str.ts'
import { type BatchRepository, DatabaseBatchRepository, MemoryBatchRepository } from './batches.ts'
import { DatabaseQueueDriver } from './drivers/database.ts'
import { MemoryQueueDriver } from './drivers/memory.ts'
import { DEFAULT_RETRY_AFTER_SECONDS } from './drivers/shared.ts'
import { QueueError } from './errors.ts'
import { checkQueueName } from './job.ts'
import { type QueueConnection, QueueManager } from './manager.ts'
import { DatabaseOutboxStore, type OutboxStore } from './outbox.ts'
import { EnvelopeSigner } from './payload.ts'
import { JobRegistry } from './registry.ts'
import {
  DatabaseFailedJobStore,
  DatabaseQueueLockStore,
  type FailedJobStore,
  MemoryFailedJobStore,
  MemoryQueueLockStore,
} from './stores.ts'
import { DEFAULT_QUEUE_TABLES } from './tables.ts'
import { QueueDispatcherToken } from './tokens.ts'

/**
 * One connection in `config/queue.ts`. Drivers read their own extra keys.
 *
 * @example
 * const database: QueueConnectionConfig = { driver: 'database', retryAfter: 90 }
 */
export interface QueueConnectionConfig {
  readonly driver: string
  /** The default queue. Default `default`. */
  readonly queue?: string
  /** Seconds a reservation lasts. Default 90. */
  readonly retryAfter?: number
  /** Database driver: the jobs table. Default `jobs`. */
  readonly table?: string
  /** Push only after the current transaction commits. Default false. */
  readonly afterCommit?: boolean
  readonly [key: string]: unknown
}

/**
 * The shape of `config/queue.ts`.
 *
 * @example
 * const config: QueueConfig = { default: 'database' }
 */
export interface QueueConfig {
  readonly default?: string
  readonly connections?: Readonly<Record<string, QueueConnectionConfig>>
  readonly failed?: { readonly driver: 'database' | 'memory'; readonly table?: string }
  /** The unique-lock table (database lock store). Default `queue_locks`. */
  readonly locksTable?: string
  /** The batch tables. Default `job_batches` and `job_batch_jobs`. */
  readonly batching?: { readonly table?: string; readonly jobsTable?: string }
  /** The transactional outbox table. Default `queue_outbox`. */
  readonly outbox?: { readonly table?: string }
  readonly maxPayloadBytes?: number
}

/**
 * What a driver factory gets.
 *
 * @example
 * const factory: QueueDriverFactory = (config, deps) => new MyDriver({ clock: deps.clock })
 */
export interface QueueDriverDeps {
  readonly name: string
  readonly clock: Clock
  /** The app's database connection (opened on first use). */
  readonly database: () => Connection
  readonly container: Container
}

/**
 * Builds a driver from its connection config.
 *
 * @example
 * registerQueueDriver(app.container, 'redis', (config, deps) => new RedisQueueDriver(…))
 */
export type QueueDriverFactory = (
  config: QueueConnectionConfig,
  deps: QueueDriverDeps,
) => QueueDriver

/**
 * The driver factories the app knows, by name (add-ons add theirs).
 *
 * @example
 * app.make(QueueDriversToken).get('database')
 */
export const QueueDriversToken: Token<Map<string, QueueDriverFactory>> =
  token<Map<string, QueueDriverFactory>>('strutvane.queue.drivers')

/**
 * The container token for the queue manager.
 *
 * @example
 * app.make(QueueManagerToken).processNext('database', ['default'])
 */
export const QueueManagerToken: Token<QueueManager> = token<QueueManager>('strutvane.queue')

/**
 * Register a queue driver (in a provider's `register()`), so `config/queue.ts` can name it.
 *
 * @example
 * registerQueueDriver(app.container, 'redis', (config, deps) => new RedisQueueDriver({ … }))
 */
export function registerQueueDriver(
  container: Container,
  name: string,
  factory: QueueDriverFactory,
  options: { readonly replace?: boolean } = {},
): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name))
    throw new QueueError(
      'queue_invalid_option',
      `"${name}" is not a valid queue driver name.`,
      'Use a short lowercase name such as "redis".',
    )
  if (!container.has(QueueDriversToken)) container.value(QueueDriversToken, builtInDrivers())
  const drivers = container.make(QueueDriversToken)
  // A driver sees every signed payload and (database) the app connection: replacing one that is
  // already registered, built in or not, must be deliberate.
  if (drivers.has(name) && options.replace !== true)
    throw new QueueError(
      'queue_invalid_option',
      `A queue driver called "${name}" is already registered.`,
      'Pick another name, or pass { replace: true } if replacing it is intended.',
    )
  drivers.set(name, factory)
}

function builtInDrivers(): Map<string, QueueDriverFactory> {
  return new Map<string, QueueDriverFactory>([
    [
      'database',
      (config, deps) =>
        lazyDriver(
          () =>
            new DatabaseQueueDriver({
              connection: deps.database(),
              table: config.table ?? DEFAULT_QUEUE_TABLES.jobs,
              retryAfter: config.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS,
              clock: deps.clock,
            }),
        ),
    ],
    [
      'memory',
      (config, deps) =>
        new MemoryQueueDriver({
          clock: deps.clock,
          retryAfter: config.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS,
        }),
    ],
  ])
}

/** A driver built on first use: booting the app never opens the database for the queue. */
function lazyDriver(make: () => QueueDriver): QueueDriver {
  let driver: QueueDriver | undefined
  const get = (): QueueDriver => {
    driver ??= make()
    return driver
  }
  return {
    // Only the built-in database driver is wrapped lazily, and it keeps ids.
    preservesIds: true,
    push: (queue, payload, options) => get().push(queue, payload, options),
    pop: (queue, options) => get().pop(queue, options),
    ack: (job) => get().ack(job),
    release: (job, delay) => get().release(job, delay),
    size: (queue) => get().size(queue),
    clear: (queue) => get().clear(queue),
    extend: async (job, seconds) => {
      const inner = get()
      return inner.extend === undefined ? false : inner.extend(job, seconds)
    },
  }
}

function badConfig(message: string, hint: string): QueueError {
  return new QueueError('queue_not_configured', message, hint)
}

function readConfig(raw: unknown): QueueConfig {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw badConfig(
      'config/queue.ts must export an object.',
      'export default defineConfig((env) => ({ default: env.string("QUEUE_CONNECTION", "database") }))',
    )
  return raw as QueueConfig
}

/**
 * Options for {@link createQueueManager}.
 *
 * @example
 * createQueueManager({ config, env, environment, keys, clock, logger, container, database })
 */
export interface CreateQueueManagerOptions {
  readonly config: unknown
  readonly env: Readonly<Record<string, string | undefined>>
  readonly environment: string
  /** Signing keys, current first (`keyring.deriveAll('queue')`). */
  readonly keys: readonly Uint8Array[]
  readonly clock: Clock
  readonly logger: Logger
  readonly container: Container
  readonly database: () => Connection
  readonly scope?: <TResult>(work: () => Promise<TResult>) => Promise<TResult>
  readonly jobs?: JobRegistry
}

/**
 * Build the queue manager from `config/queue.ts` (checked: unknown drivers, a default naming no
 * connection, bad queue names and retryAfter values stop boot).
 *
 * @example
 * const manager = createQueueManager(options)
 */
export function createQueueManager(options: CreateQueueManagerOptions): QueueManager {
  const config = readConfig(options.config)
  const fallback =
    options.env['QUEUE_CONNECTION'] ?? (options.environment === 'testing' ? 'sync' : 'database')
  const defined: Record<string, QueueConnectionConfig> = {
    sync: { driver: 'sync' },
    database: { driver: 'database' },
    ...config.connections,
  }
  const drivers = options.container.has(QueueDriversToken)
    ? options.container.make(QueueDriversToken)
    : builtInDrivers()
  const connections: QueueConnection[] = []
  for (const [name, connection] of Object.entries(defined)) {
    if (
      connection === null ||
      typeof connection !== 'object' ||
      typeof connection.driver !== 'string'
    )
      throw badConfig(
        `The "${name}" queue connection has no driver.`,
        'Give it a driver, such as { driver: "database" }.',
      )
    const retryAfter = connection.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS
    if (!Number.isInteger(retryAfter) || retryAfter < 2)
      throw badConfig(
        `The "${name}" queue connection's retryAfter must be whole seconds of at least 2; got ${String(retryAfter)}.`,
        'retryAfter is how long a reserved job is hidden from other workers; keep it above every job timeout.',
      )
    const defaultQueue = checkQueueName(connection.queue ?? 'default')
    let driver: QueueDriver | undefined
    if (connection.driver !== 'sync') {
      const factory = drivers.get(connection.driver)
      if (factory === undefined) {
        const guess = closestMatch(connection.driver, ['sync', ...drivers.keys()])
        throw new QueueError(
          'queue_driver_unknown',
          `The "${name}" queue connection uses the "${connection.driver}" driver, which nothing registered.`,
          guess === undefined
            ? `Built in: sync, ${[...drivers.keys()].join(', ')}. Add-on drivers (such as redis) come from their package; install it.`
            : `Did you mean "${guess}"?`,
        )
      }
      driver = factory(connection, {
        name,
        clock: options.clock,
        database: options.database,
        container: options.container,
      })
    }
    connections.push({
      name,
      driver,
      defaultQueue,
      retryAfter,
      afterCommit: connection.afterCommit === true,
    })
  }
  const defaultConnection = config.default ?? fallback
  if (!(defaultConnection in defined))
    throw new QueueError(
      'queue_connection_unknown',
      `The default queue connection "${defaultConnection}" is not configured.`,
      `Set QUEUE_CONNECTION (or default in config/queue.ts) to one of: ${Object.keys(defined).join(', ')}.`,
    )
  const failedDriver =
    config.failed?.driver ?? (defaultConnection === 'sync' ? 'memory' : 'database')
  const failed: FailedJobStore =
    failedDriver === 'memory'
      ? new MemoryFailedJobStore()
      : lazyFailedStore(
          () =>
            new DatabaseFailedJobStore({
              connection: options.database(),
              table: config.failed?.table ?? DEFAULT_QUEUE_TABLES.failed,
            }),
        )
  const locks: QueueLockStore =
    defaultConnection === 'sync'
      ? new MemoryQueueLockStore({ clock: options.clock })
      : lazyLocks(
          () =>
            new DatabaseQueueLockStore({
              connection: options.database(),
              table: config.locksTable ?? DEFAULT_QUEUE_TABLES.locks,
              clock: options.clock,
            }),
        )
  const sync = defaultConnection === 'sync'
  const batches: BatchRepository = sync
    ? new MemoryBatchRepository({ clock: options.clock })
    : lazyBatches(
        () =>
          new DatabaseBatchRepository({
            connection: options.database(),
            tables: {
              batches: config.batching?.table ?? DEFAULT_QUEUE_TABLES.batches,
              members: config.batching?.jobsTable ?? DEFAULT_QUEUE_TABLES.batchJobs,
            },
            clock: options.clock,
          }),
      )
  let outbox: OutboxStore | undefined
  return new QueueManager({
    batches,
    outbox: () => {
      outbox ??= new DatabaseOutboxStore({
        connection: options.database(),
        table: config.outbox?.table ?? DEFAULT_QUEUE_TABLES.outbox,
        clock: options.clock,
      })
      return outbox
    },
    connections,
    defaultConnection,
    signer: new EnvelopeSigner(
      options.keys,
      config.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: config.maxPayloadBytes },
    ),
    jobs: options.jobs ?? new JobRegistry(),
    failed,
    locks,
    logger: options.logger,
    clock: options.clock,
    transactions: () => {
      const connection = options.database()
      return {
        inTransaction: () => connection.inTransaction(),
        afterCommit: (callback, onRollback) => {
          void connection.afterCommit(callback, { onRollback })
        },
      }
    },
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  })
}

function lazyFailedStore(make: () => FailedJobStore): FailedJobStore {
  let store: FailedJobStore | undefined
  const get = (): FailedJobStore => {
    store ??= make()
    return store
  }
  return {
    log: (record) => get().log(record),
    all: (limit) => get().all(limit),
    find: (id) => get().find(id),
    forget: (id) => get().forget(id),
    flush: (before) => get().flush(before),
  }
}

function lazyBatches(make: () => BatchRepository): BatchRepository {
  let store: BatchRepository | undefined
  const get = (): BatchRepository => {
    store ??= make()
    return store
  }
  return {
    create: (batch) => get().create(batch),
    find: (id) => get().find(id),
    recordSuccess: (batchId, jobId) => get().recordSuccess(batchId, jobId),
    recordFailure: (batchId, jobId) => get().recordFailure(batchId, jobId),
    claimFinished: (batchId) => get().claimFinished(batchId),
    claimCaught: (batchId) => get().claimCaught(batchId),
    cancel: (batchId) => get().cancel(batchId),
    prune: (before) => get().prune(before),
  }
}

function lazyLocks(make: () => QueueLockStore): QueueLockStore {
  let store: QueueLockStore | undefined
  const get = (): QueueLockStore => {
    store ??= make()
    return store
  }
  return {
    acquire: (key, owner, ttl) => get().acquire(key, owner, ttl),
    release: (key, owner) => get().release(key, owner),
  }
}

/**
 * Bind the queue manager (and the dispatcher `Job.dispatch` uses) unless a provider already did.
 *
 * @example
 * bindQueue(container, options)
 */
export function bindQueue(
  container: Container,
  options: Omit<CreateQueueManagerOptions, 'container'>,
): void {
  if (!container.has(QueueManagerToken))
    container.singleton(QueueManagerToken, () => createQueueManager({ ...options, container }))
  if (!container.has(QueueDispatcherToken))
    container.singleton(QueueDispatcherToken, () => container.make(QueueManagerToken))
}
