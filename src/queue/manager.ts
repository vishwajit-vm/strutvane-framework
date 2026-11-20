/**
 * The queue manager (RFC-0006 §3, §6–§8, §10): named connections, dispatch, chains, batches,
 * unique locks, the outbox relay, the per-job lifecycle the worker drives, and the observability
 * hooks.
 *
 * The worker (`worker.ts`) is only a loop around {@link QueueManager.processNext}; everything
 * that decides what happens to a job lives here, so the `sync` connection, `dispatchSync` and the
 * worker behave the same way.
 *
 * @module
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Logger } from '../contracts/logger.ts'
import type { QueueDriver, QueueLockStore, ReservedJob } from '../contracts/queue.ts'
import { type Clock, systemClock } from '../core/clock.ts'
import { uuidv7 } from '../core/uuid.ts'
import { currentTenant } from '../database/orm/tenancy.ts'
import { assertTenantId } from '../database/types.ts'
import { closestMatch } from '../support/str.ts'
import type { BatchRepository, BatchStatus } from './batches.ts'
import { isQueueError, QueueError } from './errors.ts'
import type { QueueEvent, QueueListener } from './events.ts'
import {
  backoffDelay,
  checkQueueName,
  type DispatchOptions,
  JobCall,
  type RegisteredJob,
} from './job.ts'
import type { OutboxStore } from './outbox.ts'
import {
  assertPlainData,
  type BatchInfo,
  type ChainStep,
  type Envelope,
  type EnvelopeSigner,
  type JsonData,
} from './payload.ts'
import type { JobRegistry } from './registry.ts'
import { type AttemptOutcome, runAttempt } from './runner.ts'
import { describeError, type FailedJobStore } from './stores.ts'
import type { QueueDispatcher } from './tokens.ts'

/**
 * One resolved connection.
 *
 * @example
 * manager.connection('database').driver.size('default')
 */
export interface QueueConnection {
  readonly name: string
  /** `undefined` for the `sync` connection, which runs jobs at dispatch. */
  readonly driver: QueueDriver | undefined
  /** The queue jobs go to when neither the job nor the dispatch names one. */
  readonly defaultQueue: string
  /** Seconds a reservation lasts; a job timeout must stay below it. */
  readonly retryAfter: number
  /** Push only after the current transaction commits, unless a dispatch says otherwise. */
  readonly afterCommit: boolean
}

/**
 * What the manager needs to run `afterCommit` dispatches: the app's database connection, if any.
 *
 * @example
 * const tx: TransactionHooks = { inTransaction: () => db.inTransaction(), afterCommit: (fn) => db.afterCommit(fn) }
 */
export interface TransactionHooks {
  inTransaction(): boolean
  afterCommit(callback: () => Promise<void>): void
}

/**
 * Options for {@link QueueManager}.
 *
 * @example
 * new QueueManager({ connections: [conn], defaultConnection: 'database', signer, jobs, failed, locks, logger })
 */
export interface QueueManagerOptions {
  readonly connections: readonly QueueConnection[]
  readonly defaultConnection: string
  readonly signer: EnvelopeSigner
  readonly jobs: JobRegistry
  readonly failed: FailedJobStore
  readonly locks: QueueLockStore
  readonly logger: Logger
  readonly clock?: Clock
  /** Runs job handlers inside the app (container, config, database). */
  readonly scope?: <TResult>(work: () => Promise<TResult>) => Promise<TResult>
  readonly transactions?: () => TransactionHooks | undefined
  /** Jitter source for exponential backoff (tests pass a fixed one). */
  readonly random?: () => number
  /** Where batches live (database by default); without it `Bus.batch` is refused. */
  readonly batches?: BatchRepository
  /** The transactional outbox (database only); without it `viaOutbox` is refused. */
  readonly outbox?: () => OutboxStore | undefined
}

/** Extra envelope fields for one push. */
interface EnvelopeExtras {
  readonly chain?: readonly ChainStep[] | undefined
  readonly chainCatch?: ChainStep | undefined
  readonly unique?: Envelope['unique']
  readonly batch?: BatchInfo | undefined
  readonly id?: string
  readonly tenantId?: string | undefined
}

/**
 * What processing one reserved job ended with (the worker uses it for its counters and exits).
 *
 * @example
 * const result = await manager.processNext('database', ['default'])
 */
export interface ProcessResult {
  readonly jobId: string
  readonly job: string
  readonly outcome: 'processed' | 'released' | 'failed' | 'poisoned' | 'lost'
  /**
   * Set when the handler outlived its timeout and still hasn't stopped: resolves when it does.
   * The worker stops taking jobs and exits if it doesn't settle within its grace period.
   */
  readonly stillRunning?: Promise<void>
}

/** Per-call worker overrides. */
export interface ProcessOptions {
  /** Override every job's timeout (the worker's `--timeout`). */
  readonly timeoutSeconds?: number
}

/**
 * A chain being built: `Bus.chain([...]).onFailure(Job.with(x)).dispatch()`.
 *
 * @example
 * await manager.chain([Resize.with({ id }), Publish.with({ id })]).dispatch()
 */
export class PendingChain {
  readonly #manager: QueueManager
  readonly #calls: readonly JobCall[]
  readonly #catch: JobCall | undefined

  constructor(manager: QueueManager, calls: readonly JobCall[], onFailure?: JobCall) {
    this.#manager = manager
    this.#calls = calls
    this.#catch = onFailure
  }

  /** The job pushed once when a step fails for good. */
  onFailure(call: JobCall): PendingChain {
    return new PendingChain(this.#manager, this.#calls, call)
  }

  /** Push the first step (it carries the rest). Resolves to its id. */
  dispatch(): Promise<string | undefined> {
    return this.#manager.dispatchChain(this.#calls, this.#catch)
  }
}

/**
 * A batch being built: `Bus.batch([...]).onSuccess(Done.with(x)).dispatch()`.
 *
 * @example
 * const id = await manager.batch(rows.map((row) => ImportRow.with(row))).name('import').dispatch()
 */
export class PendingBatch {
  readonly #manager: QueueManager
  readonly #calls: readonly JobCall[]
  readonly #options: BatchOptions

  constructor(manager: QueueManager, calls: readonly JobCall[], options: BatchOptions = {}) {
    this.#manager = manager
    this.#calls = calls
    this.#options = options
  }

  /** A name for dashboards and `findBatch`. */
  name(name: string): PendingBatch {
    return new PendingBatch(this.#manager, this.#calls, { ...this.#options, name })
  }

  /** Keep going when a job fails for good (the batch is not cancelled; `onSuccess` is skipped). */
  allowFailures(): PendingBatch {
    return new PendingBatch(this.#manager, this.#calls, { ...this.#options, allowFailures: true })
  }

  /**
   * Pushed once when every job succeeded (Laravel's `then`; renamed because an object with a
   * `then` method is a thenable, and `await`ing the builder would call it).
   */
  onSuccess(call: JobCall): PendingBatch {
    return new PendingBatch(this.#manager, this.#calls, { ...this.#options, onSuccess: call })
  }

  /** Pushed once, on the first job that failed for good (Laravel's `catch`). */
  onFailure(call: JobCall): PendingBatch {
    return new PendingBatch(this.#manager, this.#calls, { ...this.#options, onFailure: call })
  }

  /** Pushed once when every job has finished, successfully or not (Laravel's `finally`). */
  onFinish(call: JobCall): PendingBatch {
    return new PendingBatch(this.#manager, this.#calls, { ...this.#options, onFinish: call })
  }

  /** Create the batch and push its jobs. Resolves to the batch id. */
  dispatch(): Promise<string> {
    return this.#manager.dispatchBatch(this.#calls, this.#options)
  }
}

/**
 * What a batch is built with.
 *
 * @example
 * const options: BatchOptions = { name: 'import', allowFailures: true }
 */
export interface BatchOptions {
  readonly name?: string
  readonly allowFailures?: boolean
  readonly onSuccess?: JobCall
  readonly onFailure?: JobCall
  readonly onFinish?: JobCall
}

const SYNC = 'sync'

/**
 * The queue manager.
 *
 * @example
 * await manager.dispatch(SendWelcomeEmail.with({ userId }))
 */
export class QueueManager implements QueueDispatcher {
  readonly #connections = new Map<string, QueueConnection>()
  readonly #default: string
  readonly #signer: EnvelopeSigner
  readonly #clock: Clock
  readonly #listeners = new Set<QueueListener>()
  readonly #options: QueueManagerOptions
  /** The job registry the worker resolves names with. */
  readonly jobs: JobRegistry
  /** The failed-job store. */
  readonly failed: FailedJobStore
  /** The lock store unique jobs use. */
  readonly locks: QueueLockStore
  readonly #logger: Logger
  #relayDisabled = false

  constructor(options: QueueManagerOptions) {
    for (const connection of options.connections) {
      checkQueueName(connection.defaultQueue)
      this.#connections.set(connection.name, connection)
    }
    this.#options = options
    this.#signer = options.signer
    this.#clock = options.clock ?? systemClock
    this.jobs = options.jobs
    this.failed = options.failed
    this.locks = options.locks
    this.#logger = options.logger.child({ component: 'queue' })
    this.#default = options.defaultConnection
    this.connection(options.defaultConnection)
  }

  /** The default connection's name. */
  get defaultConnection(): string {
    return this.#default
  }

  /** Every connection name. */
  get connectionNames(): readonly string[] {
    return [...this.#connections.keys()]
  }

  /**
   * A connection by name (default when omitted); `queue_connection_unknown` otherwise.
   *
   * @example
   * manager.connection('database').driver
   */
  connection(name: string = this.#default): QueueConnection {
    const found = this.#connections.get(name)
    if (found !== undefined) return found
    const guess = closestMatch(name, [...this.#connections.keys()])
    throw new QueueError(
      'queue_connection_unknown',
      `No queue connection is called "${name}".`,
      guess === undefined
        ? `Add it to connections in config/queue.ts (known: ${[...this.#connections.keys()].join(', ')}).`
        : `Did you mean "${guess}"?`,
    )
  }

  /**
   * Subscribe to queue events; returns the unsubscribe function.
   *
   * @example
   * const stop = manager.listen((event) => events.push(event))
   */
  listen(listener: QueueListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Emit an event to every listener (errors are logged, never thrown). */
  emit(event: Omit<QueueEvent, 'at'>): void {
    const full: QueueEvent = { at: this.#clock.now(), ...event }
    for (const listener of this.#listeners) {
      try {
        listener(full)
      } catch (error) {
        this.#logger.warn('A queue event listener threw; the event was skipped for it.', {
          event: full.type,
          error: describeError(error).message,
        })
      }
    }
  }

  /**
   * Start a chain.
   *
   * @example
   * await manager.chain([A.with(a), B.with(b)]).dispatch()
   */
  chain(calls: readonly JobCall[]): PendingChain {
    return new PendingChain(this, calls)
  }

  /**
   * Start a batch.
   *
   * @example
   * await manager.batch(rows.map((row) => ImportRow.with(row))).onSuccess(Done.with({})).dispatch()
   */
  batch(calls: readonly JobCall[]): PendingBatch {
    return new PendingBatch(this, calls)
  }

  #batches(): BatchRepository {
    const batches = this.#options.batches
    if (batches === undefined)
      throw new QueueError(
        'queue_not_configured',
        'Batches need a batch store, and this queue has none.',
        'Batches live in the job_batches tables: run node strut queue:table && node strut migrate, and use a database-backed app.',
      )
    return batches
  }

  /**
   * A batch's progress, or `undefined`.
   *
   * @example
   * const batch = await manager.findBatch(id)
   */
  async findBatch(id: string): Promise<BatchStatus | undefined> {
    return this.#batches().find(id)
  }

  /**
   * Cancel a batch: its jobs still run unless they check `ctx.batch()`, and `onSuccess` never runs.
   *
   * @example
   * await manager.cancelBatch(id)
   */
  async cancelBatch(id: string): Promise<boolean> {
    return this.#batches().cancel(id)
  }

  /**
   * Remove finished or cancelled batches older than `beforeMs` (`queue:prune-batches`).
   *
   * @example
   * await manager.pruneBatches(Date.now() - 24 * 3_600_000)
   */
  async pruneBatches(beforeMs: number): Promise<number> {
    return this.#batches().prune(beforeMs)
  }

  /**
   * Remove dispatched outbox rows older than `beforeMs` (`queue:prune-outbox`); 0 without an
   * outbox.
   *
   * @example
   * await manager.pruneOutbox(Date.now() - 24 * 3_600_000)
   */
  async pruneOutbox(beforeMs: number): Promise<number> {
    const outbox = this.#options.outbox?.()
    return outbox === undefined ? 0 : outbox.prune(beforeMs)
  }

  /** Create a batch and push its jobs (see {@link PendingBatch}). */
  async dispatchBatch(calls: readonly JobCall[], options: BatchOptions): Promise<string> {
    const batches = this.#batches()
    const id = uuidv7()
    const info: BatchInfo = {
      id,
      allowFailures: options.allowFailures === true,
      ...(options.onSuccess === undefined
        ? {}
        : { onSuccess: this.#step(options.onSuccess, 'batch.onSuccess') }),
      ...(options.onFailure === undefined
        ? {}
        : { onFailure: this.#step(options.onFailure, 'batch.onFailure') }),
      ...(options.onFinish === undefined
        ? {}
        : { onFinish: this.#step(options.onFinish, 'batch.onFinish') }),
    }
    // Build (and so validate) every envelope before anything is stored or pushed.
    const members: { envelope: Envelope; call: JobCall; delay: number }[] = []
    for (const [index, call] of calls.entries()) {
      if (call.job.uniqueLock(call.data) !== undefined)
        throw new QueueError(
          'queue_invalid_option',
          `The "${call.job.name}" job is unique and can't be part of a batch (batch[${index}]).`,
          'Dispatch unique jobs on their own; a skipped member would leave the batch unfinished.',
        )
      const connection = call.options.connection ?? call.job.options.connection ?? this.#default
      const envelope = await this.#envelope(call, connection, { batch: info })
      this.#signer.encode(envelope)
      members.push({ envelope, call, delay: this.#delaySeconds(call.options) })
    }
    const name = options.name ?? ''
    await batches.create({ id, name, jobIds: members.map((member) => member.envelope.id) })
    try {
      for (const member of members)
        await this.#push(
          this.connection(member.envelope.connection),
          member.envelope,
          member.delay,
          member.call.job,
        )
    } catch (error) {
      await batches.cancel(id)
      throw error
    }
    if (members.length === 0) {
      const tenantId = currentTenant()
      await this.#finishBatch(info, tenantId)
    }
    return id
  }

  /**
   * Queue a job (see `Job.dispatch`). Resolves to its id, or `undefined` when a unique job's
   * lock is held.
   */
  async dispatch(call: JobCall): Promise<string | undefined> {
    return this.#dispatch(call, undefined, undefined)
  }

  /** Push the first step of a chain; it carries the rest. */
  async dispatchChain(
    calls: readonly JobCall[],
    onFailure: JobCall | undefined,
  ): Promise<string | undefined> {
    const [first, ...rest] = calls
    if (first === undefined)
      throw new QueueError(
        'queue_invalid_option',
        'A chain needs at least one job.',
        'Pass the jobs in order: Bus.chain([A.with(a), B.with(b)]).',
      )
    const steps = rest.map((call, index) => this.#step(call, `chain[${index + 1}]`))
    const catchStep = onFailure === undefined ? undefined : this.#step(onFailure, 'chain.catch')
    return this.#dispatch(first, steps, catchStep)
  }

  /**
   * Run a job now in this process, through the whole lifecycle (validation, tenant, retries
   * without delays, `failed()`); the final error is thrown to the caller.
   */
  async dispatchSync(call: JobCall): Promise<void> {
    const connection = call.options.connection ?? call.job.options.connection ?? this.#default
    const envelope = await this.#envelope(call, connection, {})
    await this.#runSync(envelope, call.job)
  }

  #step(call: JobCall, path: string): ChainStep {
    const data = assertPlainData(call.data, `${path}.data`)
    const delay = this.#delaySeconds(call.options)
    return {
      job: call.job.name,
      data,
      ...(call.options.queue === undefined ? {} : { queue: checkQueueName(call.options.queue) }),
      ...(call.options.connection === undefined ? {} : { connection: call.options.connection }),
      ...(delay === 0 ? {} : { delaySeconds: delay }),
    }
  }

  #delaySeconds(options: DispatchOptions): number {
    const { delay } = options
    if (delay === undefined) return 0
    const seconds =
      delay instanceof Date ? Math.ceil((delay.getTime() - this.#clock.now()) / 1000) : delay
    if (!Number.isInteger(seconds) && !(delay instanceof Date))
      throw new QueueError(
        'queue_invalid_option',
        `A dispatch delay must be whole seconds or a Date; got ${String(delay)}.`,
        'Pass delay: 60 or delay: new Date(...).',
      )
    return Math.max(0, seconds)
  }

  async #envelope(
    call: JobCall,
    connectionName: string,
    extras: EnvelopeExtras,
  ): Promise<Envelope> {
    const { chain, chainCatch, unique, batch, id } = extras
    const connection = this.connection(connectionName)
    const options = call.job.options
    const queue = checkQueueName(call.options.queue ?? options.queue ?? connection.defaultQueue)
    const data: JsonData = assertPlainData(call.data)
    await call.job.parse(data)
    if (connection.driver !== undefined && options.timeout >= connection.retryAfter)
      throw new QueueError(
        'queue_timeout_not_below_retry_after',
        `The "${call.job.name}" job's timeout (${options.timeout}s) is not below the "${connection.name}" connection's retryAfter (${connection.retryAfter}s).`,
        'Lower the job timeout or raise retryAfter in config/queue.ts: otherwise a slow job is handed to a second worker while it still runs.',
      )
    const tenantId = 'tenantId' in extras ? extras.tenantId : currentTenant()
    if (tenantId !== undefined) assertTenantId(tenantId)
    const now = this.#clock.now()
    return {
      v: 1,
      id: id ?? uuidv7(),
      job: call.job.name,
      data,
      queue,
      connection: connection.name,
      dispatchedAt: now,
      tries: options.tries,
      backoff: options.backoff,
      timeout: options.timeout,
      ...(options.retryUntil === undefined ? {} : { retryUntil: now + options.retryUntil * 1000 }),
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(chain === undefined || chain.length === 0 ? {} : { chain }),
      ...(chainCatch === undefined ? {} : { chainCatch }),
      ...(unique === undefined ? {} : { unique }),
      ...(batch === undefined ? {} : { batch }),
    }
  }

  async #dispatch(
    call: JobCall,
    chain: readonly ChainStep[] | undefined,
    chainCatch: ChainStep | undefined,
  ): Promise<string | undefined> {
    const connectionName = call.options.connection ?? call.job.options.connection ?? this.#default
    const connection = this.connection(connectionName)
    const lock = call.job.uniqueLock(call.data)
    let unique: Envelope['unique']
    if (lock !== undefined) {
      const owner = randomBytes(12).toString('base64url')
      if (!(await this.locks.acquire(lock.key, owner, lock.for))) {
        this.emit({
          type: 'queue.job.skipped',
          connection: connection.name,
          job: call.job.name,
          reason: 'unique lock held',
        })
        return undefined
      }
      unique = { key: lock.key, owner, until: lock.until }
    }
    try {
      const envelope = await this.#envelope(call, connection.name, { chain, chainCatch, unique })
      const delay = this.#delaySeconds(call.options)
      if (call.options.viaOutbox === true) {
        // In the caller's transaction (if any): the job exists exactly when the data committed.
        await this.#addToOutbox(connection, envelope, delay)
        return envelope.id
      }
      const push = async (): Promise<void> => {
        await this.#push(connection, envelope, delay, call.job)
      }
      const afterCommit = call.options.afterCommit ?? connection.afterCommit
      const tx = afterCommit ? this.#options.transactions?.() : undefined
      if (tx?.inTransaction() === true) {
        tx.afterCommit(async () => {
          try {
            await push()
          } catch (error) {
            this.#logger.error('A job dispatched after commit could not be pushed.', {
              jobId: envelope.id,
              job: envelope.job,
              error: describeError(error).message,
            })
            await this.#releaseUnique(envelope)
          }
        })
      } else {
        await push()
      }
      return envelope.id
    } catch (error) {
      if (unique !== undefined) await this.locks.release(unique.key, unique.owner)
      throw error
    }
  }

  async #push(
    connection: QueueConnection,
    envelope: Envelope,
    delaySeconds: number,
    job: RegisteredJob,
  ): Promise<void> {
    if (connection.driver === undefined) {
      await this.#runSync(envelope, job)
      return
    }
    await connection.driver.push(envelope.queue, this.#signer.encode(envelope), {
      id: envelope.id,
      ...(delaySeconds > 0 ? { delaySeconds } : {}),
    })
    this.emit({
      type: 'queue.job.queued',
      connection: connection.name,
      queue: envelope.queue,
      jobId: envelope.id,
      job: envelope.job,
      ...(delaySeconds > 0 ? { delaySeconds } : {}),
    })
  }

  async #addToOutbox(
    connection: QueueConnection,
    envelope: Envelope,
    delaySeconds: number,
  ): Promise<void> {
    const outbox = this.#options.outbox?.()
    if (outbox === undefined || connection.driver === undefined)
      throw new QueueError(
        'queue_not_configured',
        connection.driver === undefined
          ? `The "${connection.name}" connection runs jobs at dispatch, so it can't go through the outbox.`
          : 'viaOutbox needs the queue_outbox table on the app database, and this queue has no outbox.',
        'Use a queued connection (such as database) and run node strut queue:table && node strut migrate.',
      )
    await outbox.add({
      id: envelope.id,
      connection: connection.name,
      queue: envelope.queue,
      payload: this.#signer.encode(envelope),
      availableAt: this.#clock.now() + delaySeconds * 1000,
    })
    this.emit({
      type: 'queue.job.queued',
      connection: connection.name,
      queue: envelope.queue,
      jobId: envelope.id,
      job: envelope.job,
      reason: 'outbox',
      ...(delaySeconds > 0 ? { delaySeconds } : {}),
    })
  }

  /**
   * Move due outbox rows to their queues (one relay tick; workers run it when idle). Returns how
   * many rows were pushed. A row that can't be pushed stays claimed until its claim runs out,
   * then is tried again.
   *
   * @example
   * await manager.relayOutbox()
   */
  async relayOutbox(limit = 20): Promise<number> {
    if (this.#relayDisabled) return 0
    const outbox = this.#options.outbox?.()
    if (outbox === undefined) return 0
    let claimed: Awaited<ReturnType<OutboxStore['claim']>>
    try {
      claimed = await outbox.claim(limit, 60)
    } catch (error) {
      // Usually a missing queue_outbox table (an app that never used the outbox): say it once
      // and stop trying in this process, instead of an error on every idle tick.
      this.#relayDisabled = true
      this.#logger.warn('The outbox relay is off in this process: the outbox could not be read.', {
        error: describeError(error).message,
        hint: 'Run node strut queue:table && node strut migrate if you dispatch with viaOutbox.',
      })
      return 0
    }
    const { messages, claim } = claimed
    let pushed = 0
    for (const message of messages) {
      try {
        const driver = this.connection(message.connection).driver
        if (driver === undefined) throw new Error(`"${message.connection}" has no queue driver.`)
        await driver.push(message.queue, message.payload, { id: message.id })
        await outbox.markDispatched(message.id, claim)
        pushed++
      } catch (error) {
        this.#logger.error(
          'An outbox row could not be pushed; it is retried when its claim runs out.',
          {
            jobId: message.id,
            connection: message.connection,
            error: describeError(error).message,
          },
        )
      }
    }
    return pushed
  }

  /** The `sync` path: attempts back to back, in this process; the final error is thrown. */
  async #runSync(envelope: Envelope, job: RegisteredJob): Promise<void> {
    // The same bytes a worker would see: what can't be signed can't run synchronously either.
    this.#signer.encode(envelope)
    const data = await job.parse(envelope.data)
    if (envelope.unique?.until === 'processing') await this.#releaseUnique(envelope)
    for (let attempt = 1; ; attempt++) {
      const started = this.#clock.now()
      const outcome = await this.#attempt(job, data, envelope, attempt, SYNC, {})
      if (outcome.kind === 'done') {
        await this.#afterSuccess(envelope, SYNC, attempt, started)
        return
      }
      // A job that keeps releasing itself must still stop: a release counts as an attempt.
      const final = outcome.kind === 'failed' ? outcome.final : attempt >= envelope.tries
      if (final) {
        const error =
          outcome.kind === 'failed'
            ? outcome.error
            : new QueueError(
                'queue_max_attempts_exceeded',
                `The "${envelope.job}" job released itself on every one of its ${envelope.tries} attempt(s).`,
                'Raise tries, or stop calling ctx.release() once the condition can no longer change.',
              )
        await this.#afterFinalFailure(envelope, error, SYNC, attempt, job, data, undefined)
        throw error
      }
    }
  }

  #attempt(
    job: RegisteredJob,
    data: unknown,
    envelope: Envelope,
    attempt: number,
    connection: string,
    options: ProcessOptions,
  ): Promise<AttemptOutcome> {
    this.emit({
      type: 'queue.job.processing',
      connection,
      queue: envelope.queue,
      jobId: envelope.id,
      job: envelope.job,
      attempt,
    })
    return runAttempt({
      job,
      data,
      envelope,
      attempt,
      connection,
      logger: this.#logger,
      now: () => this.#clock.now(),
      findBatch: (id) => this.#options.batches?.find(id) ?? Promise.resolve(undefined),
      ...(this.#options.scope === undefined ? {} : { scope: this.#options.scope }),
      ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    })
  }

  /**
   * Reserve and process the next job from the first of `queues` that has one. `undefined` when
   * every queue is empty. This is one turn of the worker loop.
   *
   * @example
   * while (await manager.processNext('database', ['high', 'default'])) {}
   */
  async processNext(
    connectionName: string,
    queues: readonly string[],
    options: ProcessOptions = {},
  ): Promise<ProcessResult | undefined> {
    const connection = this.connection(connectionName)
    const driver = connection.driver
    if (driver === undefined)
      throw new QueueError(
        'queue_invalid_option',
        `The "${connection.name}" connection runs jobs at dispatch; there is nothing to work.`,
        'Run the worker on a queued connection, such as database: node strut queue:work database.',
      )
    for (const queue of queues) {
      const reserved = await driver.pop(checkQueueName(queue), {
        visibilitySeconds: connection.retryAfter,
      })
      if (reserved !== undefined) return this.#process(connection, driver, reserved, options)
    }
    return undefined
  }

  async #process(
    connection: QueueConnection,
    driver: QueueDriver,
    reserved: ReservedJob,
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    let envelope: Envelope
    let job: RegisteredJob
    let data: unknown
    try {
      envelope = this.#signer.decode(reserved.payload)
      job = this.jobs.require(envelope.job)
      if (envelope.tenantId !== undefined) assertTenantId(envelope.tenantId)
      data = await job.parse(envelope.data)
    } catch (error) {
      return this.#poison(connection, driver, reserved, error)
    }
    const attempt = reserved.attempts
    const now = this.#clock.now()
    if (
      attempt > envelope.tries ||
      (envelope.retryUntil !== undefined && now > envelope.retryUntil)
    ) {
      const error = new QueueError(
        'queue_max_attempts_exceeded',
        `The "${envelope.job}" job was attempted ${attempt - 1} time(s) without finishing; its limit is ${envelope.tries}.`,
        'An earlier attempt probably crashed or killed the worker (memory, a native crash). Check the worker logs around this job id.',
      )
      await this.#afterFinalFailure(
        envelope,
        error,
        connection.name,
        attempt,
        job,
        data,
        reserved.payload,
      )
      await this.#ack(driver, reserved, envelope)
      return { jobId: envelope.id, job: envelope.job, outcome: 'failed' }
    }
    if (envelope.unique?.until === 'processing') await this.#releaseUnique(envelope)
    const started = this.#clock.now()
    const outcome = await this.#attempt(job, data, envelope, attempt, connection.name, options)
    const base = { jobId: envelope.id, job: envelope.job }
    const stillRunning =
      outcome.kind === 'failed' && outcome.timedOut ? { stillRunning: outcome.settled } : {}
    if (outcome.kind === 'done') {
      await this.#afterSuccess(envelope, connection.name, attempt, started)
      const acked = await this.#ack(driver, reserved, envelope)
      return { ...base, outcome: acked ? 'processed' : 'lost' }
    }
    if (outcome.kind === 'released') {
      const ok = await driver.release(reserved, outcome.delaySeconds)
      this.emit({
        type: 'queue.job.released',
        connection: connection.name,
        queue: envelope.queue,
        jobId: envelope.id,
        job: envelope.job,
        attempt,
        delaySeconds: outcome.delaySeconds,
      })
      return { ...base, outcome: ok ? 'released' : 'lost' }
    }
    if (!outcome.final) {
      const delay = backoffDelay(envelope.backoff, attempt, this.#options.random)
      const ok = await driver.release(reserved, delay)
      this.#logger.warn('A job attempt failed; it will be retried.', {
        jobId: envelope.id,
        job: envelope.job,
        attempt,
        retryInSeconds: delay,
        errorCode: errorCode(outcome.error),
      })
      this.emit({
        type: 'queue.job.released',
        connection: connection.name,
        queue: envelope.queue,
        jobId: envelope.id,
        job: envelope.job,
        attempt,
        delaySeconds: delay,
        errorCode: errorCode(outcome.error),
      })
      return { ...base, outcome: ok ? 'released' : 'lost', ...stillRunning }
    }
    await this.#afterFinalFailure(
      envelope,
      outcome.error,
      connection.name,
      attempt,
      job,
      data,
      reserved.payload,
    )
    await this.#ack(driver, reserved, envelope)
    return { ...base, outcome: 'failed', ...stillRunning }
  }

  async #ack(driver: QueueDriver, reserved: ReservedJob, envelope: Envelope): Promise<boolean> {
    const acked = await driver.ack(reserved)
    if (!acked)
      this.#logger.warn(
        'A job finished after its reservation ran out; another worker may run it again. Keep job timeouts below retryAfter.',
        { jobId: envelope.id, job: envelope.job },
      )
    return acked
  }

  /** A payload that can't run: straight to the failed store, acknowledged, never retried. */
  async #poison(
    connection: QueueConnection,
    driver: QueueDriver,
    reserved: ReservedJob,
    error: unknown,
  ): Promise<ProcessResult> {
    const code = errorCode(error)
    const name = jobNameOf(reserved.payload)
    this.#logger.warn('A queued job was refused and moved to the failed jobs without running.', {
      jobId: reserved.id,
      queue: reserved.queue,
      errorCode: code,
    })
    await this.failed.log({
      id: reserved.id,
      connection: connection.name,
      queue: reserved.queue,
      job: name,
      payload: reserved.payload,
      error: describeError(error),
      failedAt: this.#clock.now(),
    })
    await driver.ack(reserved)
    this.emit({
      type: 'queue.job.failed',
      connection: connection.name,
      queue: reserved.queue,
      jobId: reserved.id,
      job: name,
      attempt: reserved.attempts,
      errorCode: code,
    })
    return { jobId: reserved.id, job: name, outcome: 'poisoned' }
  }

  async #afterSuccess(
    envelope: Envelope,
    connection: string,
    attempt: number,
    started: number,
  ): Promise<void> {
    const [next, ...rest] = envelope.chain ?? []
    if (next !== undefined) {
      // Pushed before this job is acknowledged, with an id derived from this one: a crash in
      // between makes the second push a no-op on drivers with idempotent pushes.
      await this.#pushStep(next, rest, envelope, deriveId(envelope.id, 'chain-next'))
    }
    if (envelope.unique?.until === 'completed') await this.#releaseUnique(envelope)
    if (envelope.batch !== undefined) {
      const recorded = await this.#batches().recordSuccess(envelope.batch.id, envelope.id)
      if (recorded.counted && recorded.status?.pending === 0)
        await this.#finishBatch(envelope.batch, envelope.tenantId)
    }
    this.emit({
      type: 'queue.job.processed',
      connection,
      queue: envelope.queue,
      jobId: envelope.id,
      job: envelope.job,
      attempt,
      durationMs: this.#clock.now() - started,
    })
  }

  async #afterFinalFailure(
    envelope: Envelope,
    error: Error,
    connection: string,
    attempt: number,
    job: RegisteredJob,
    data: unknown,
    payload: string | undefined,
  ): Promise<void> {
    this.#logger.error('A job failed for good.', {
      jobId: envelope.id,
      job: envelope.job,
      attempt,
      errorCode: errorCode(error),
    })
    if (payload !== undefined) {
      await this.failed.log({
        id: envelope.id,
        connection,
        queue: envelope.queue,
        job: envelope.job,
        payload,
        error: describeError(error),
        failedAt: this.#clock.now(),
      })
    }
    try {
      const controller = new AbortController()
      await job.onFailure(data, error, {
        jobId: envelope.id,
        attempt,
        queue: envelope.queue,
        connection,
        tenantId: envelope.tenantId,
        signal: controller.signal,
        log: this.#logger.child({ jobId: envelope.id, job: envelope.job, attempt }),
        batchId: envelope.batch?.id,
        batch: () => this.findBatchOf(envelope),
        release() {},
        fail() {},
      })
    } catch (hookError) {
      this.#logger.error("A job's failed() hook threw.", {
        jobId: envelope.id,
        job: envelope.job,
        error: describeError(hookError).message,
      })
    }
    if (envelope.chainCatch !== undefined)
      await this.#pushStep(envelope.chainCatch, [], envelope, deriveId(envelope.id, 'chain-catch'))
    await this.#releaseUnique(envelope)
    if (envelope.batch !== undefined) await this.#batchFailure(envelope.batch, envelope)
    this.emit({
      type: 'queue.job.failed',
      connection,
      queue: envelope.queue,
      jobId: envelope.id,
      job: envelope.job,
      attempt,
      errorCode: errorCode(error),
    })
  }

  async #pushStep(
    step: ChainStep,
    rest: readonly ChainStep[],
    parent: Pick<Envelope, 'tenantId' | 'chainCatch'>,
    id: string,
  ): Promise<void> {
    const job = this.jobs.require(step.job)
    const call = new JobCall(job, step.data, {
      ...(step.queue === undefined ? {} : { queue: step.queue }),
      ...(step.connection === undefined ? {} : { connection: step.connection }),
    })
    const connectionName = step.connection ?? job.options.connection ?? this.#default
    const envelope = await this.#envelope(call, connectionName, {
      chain: rest,
      chainCatch: rest.length > 0 ? parent.chainCatch : undefined,
      id,
      tenantId: parent.tenantId,
    })
    await this.#push(this.connection(connectionName), envelope, step.delaySeconds ?? 0, job)
  }

  /** A batch member failed for good: count it once, run `catch` once, cancel unless allowed. */
  async #batchFailure(batch: BatchInfo, envelope: Envelope): Promise<void> {
    const batches = this.#batches()
    const recorded = await batches.recordFailure(batch.id, envelope.id)
    if (!recorded.counted) return
    if (await batches.claimCaught(batch.id)) {
      if (!batch.allowFailures) await batches.cancel(batch.id)
      if (batch.onFailure !== undefined)
        await this.#pushStep(batch.onFailure, [], envelope, deriveId(batch.id, 'batch-failure'))
    }
    if (recorded.status?.pending === 0) await this.#finishBatch(batch, envelope.tenantId)
  }

  /** Nothing pending: claim the finish once, then push `then` (no failures) and `finally`. */
  async #finishBatch(batch: BatchInfo, tenantId: string | undefined): Promise<void> {
    const batches = this.#batches()
    if (!(await batches.claimFinished(batch.id))) return
    const status = await batches.find(batch.id)
    const parent: Pick<Envelope, 'tenantId'> = tenantId === undefined ? {} : { tenantId }
    if (
      batch.onSuccess !== undefined &&
      status !== undefined &&
      status.failed === 0 &&
      !status.cancelled
    )
      await this.#pushStep(batch.onSuccess, [], parent, deriveId(batch.id, 'batch-success'))
    if (batch.onFinish !== undefined)
      await this.#pushStep(batch.onFinish, [], parent, deriveId(batch.id, 'batch-finish'))
  }

  /** The batch of a job's envelope, if any. */
  findBatchOf(envelope: Envelope): Promise<BatchStatus | undefined> {
    if (envelope.batch === undefined || this.#options.batches === undefined)
      return Promise.resolve(undefined)
    return this.#options.batches.find(envelope.batch.id)
  }

  async #releaseUnique(envelope: Envelope): Promise<void> {
    if (envelope.unique === undefined) return
    await this.locks.release(envelope.unique.key, envelope.unique.owner)
  }

  /**
   * Push a failed job again (`queue:retry`): the stored payload is verified first, so a tampered
   * one is refused here too; then it is removed from the failed store.
   *
   * @example
   * await manager.retryFailed(id)
   */
  async retryFailed(id: string): Promise<boolean> {
    const record = await this.failed.find(id)
    if (record === undefined) return false
    const envelope = this.#signer.decode(record.payload)
    const connection = this.connection(record.connection)
    if (connection.driver === undefined) {
      await this.#runSync(envelope, this.jobs.require(envelope.job))
    } else {
      await connection.driver.push(record.queue, record.payload, { id: envelope.id })
      this.emit({
        type: 'queue.job.queued',
        connection: connection.name,
        queue: record.queue,
        jobId: envelope.id,
        job: envelope.job,
      })
    }
    await this.failed.forget(id)
    return true
  }
}

/**
 * A stable id derived from another (chain steps, catch jobs): the same input gives the same id,
 * so a repeated push is recognised as the same job.
 *
 * @example
 * deriveId('0193…', 'chain-next')
 */
export function deriveId(id: string, purpose: string): string {
  const hex = createHash('sha256').update(`${id}:${purpose}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function errorCode(error: unknown): string {
  if (isQueueError(error)) return error.code
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : error.name
  }
  return 'Error'
}

function jobNameOf(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed !== null && typeof parsed === 'object') {
      const job = (parsed as { job?: unknown }).job
      if (typeof job === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(job)) return job
    }
  } catch {
    // Not JSON: there's no name to show.
  }
  return '(unknown)'
}
