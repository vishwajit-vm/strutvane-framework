/**
 * The connection: runs fragments, owns transactions, reports every query.
 *
 * Transactions follow Laravel's model: `transaction(fn)` commits when `fn` resolves and rolls
 * back when it throws; calling it again inside opens a SAVEPOINT, so an inner failure undoes only
 * the inner work. The difference from Laravel: Node is concurrent, so "the current transaction"
 * travels with the async call chain (AsyncLocalStorage), not with a global connection object.
 * `Post.create()` inside the callback joins the transaction automatically, while a request
 * running in parallel never does.
 *
 * Tenancy on Postgres (ADR-0007): a statement on a tenant table runs inside a transaction that
 * first calls `set_config('app.tenant_id', …, true)`, transaction-locally, so row-level security
 * enforces the same boundary as the ORM's tenant scope even if app code removes that scope.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { TenantMismatchError } from '../orm/errors.ts'
import type { SqlFragment } from '../sql/fragment.ts'
import { type Grammar, grammarFor, type RenderedSql } from '../sql/grammar.ts'
import type { Driver, DriverSession, QueryResult } from './driver.ts'
import { guardStatement } from './guard.ts'

/**
 * What a query listener receives. Parameters are included for debugging and tests; in the
 * product they pass through the logger's redaction (RFC-0004) before being written anywhere.
 *
 * @example
 * connection.onQuery((event) => console.log(event.sql, event.durationMs))
 */
export interface QueryEvent {
  readonly sql: string
  readonly params: readonly unknown[]
  readonly durationMs: number
}

/**
 * Options for one statement or transaction.
 *
 * @example
 * await connection.run(fragment, { tenantId })
 */
export interface RunOptions {
  /** The tenant this statement belongs to; Postgres sets it for row-level security. */
  readonly tenantId?: string
}

/** The state of one open transaction level, carried by AsyncLocalStorage. */
interface TransactionState {
  readonly session: DriverSession
  /** 1 for the outermost transaction, 2 for the first savepoint, … */
  readonly depth: number
  /**
   * Shared by every level of one transaction: the tenant set with set_config, and whether the
   * transaction has ended (async work started inside it may still be running afterwards).
   */
  readonly shared: {
    tenantId: string | undefined
    ended: boolean
    /** Callbacks for after the outermost COMMIT (see Connection.afterCommit). */
    afterCommit: (() => Promise<void>)[]
  }
  /** True while a nested level is open (two parallel savepoints on one connection would interleave). */
  childOpen: boolean
}

/**
 * A database connection the ORM uses.
 *
 * @example
 * const db = new Connection(sqliteDriver(':memory:'))
 * await db.transaction(async () => { await Post.create({ title: 'Hi' }) })
 */
export class Connection {
  readonly #driver: Driver
  readonly #transactions = new AsyncLocalStorage<TransactionState>()
  /** A driver session pinned by {@link Connection.session} for the current async call chain. */
  readonly #pinned = new AsyncLocalStorage<DriverSession>()
  readonly #listeners = new Set<(event: QueryEvent) => void>()
  /** The dialect's grammar, used by the compiler. */
  readonly grammar: Grammar

  constructor(driver: Driver) {
    this.#driver = driver
    this.grammar = grammarFor(
      driver.dialect,
      driver.insertReturning === undefined ? {} : { insertReturning: driver.insertReturning },
    )
  }

  /**
   * Listen to every statement (Laravel's `DB::listen`). Returns the "stop listening" function.
   *
   * @example
   * const stop = db.onQuery(() => count++)
   * stop()
   */
  onQuery(listener: (event: QueryEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Is the current async call chain inside a transaction on this connection?
   *
   * @example
   * await db.transaction(async () => db.inTransaction()) // true
   */
  inTransaction(): boolean {
    return this.#transactions.getStore() !== undefined
  }

  /**
   * Run one fragment and return its rows. Inside a transaction it uses the transaction's
   * connection; on Postgres a tenant statement outside a transaction gets its own tiny one.
   *
   * @example
   * const { rows } = await db.run(sql`SELECT 1 AS one`)
   */
  async run(fragment: SqlFragment, options: RunOptions = {}): Promise<QueryResult> {
    // Every statement passes the guard first (the ORM's tenant check lives there).
    guardStatement(fragment)
    const rendered = this.grammar.render(fragment)
    const state = this.#transactions.getStore()
    if (state !== undefined) {
      await this.#applyTenant(state, options.tenantId)
      return this.#executeIn(state, rendered)
    }
    if (options.tenantId !== undefined && this.grammar.dialect === 'postgres') {
      // RLS reads the tenant from a transaction-local setting, so the statement needs a transaction.
      return this.transaction(() => this.run(fragment, options), options)
    }
    const pinned = this.#pinned.getStore()
    if (pinned !== undefined) return this.#execute(pinned, rendered)
    const session = await this.#driver.acquire()
    let broken = false
    try {
      return await this.#execute(session, rendered)
    } catch (error) {
      broken = isConnectionFailure(error)
      throw error
    } finally {
      session.release(broken)
    }
  }

  /**
   * Run `fn` in a transaction. Nested calls become savepoints. Inner work joins automatically.
   *
   * @example
   * await db.transaction(async () => {
   *   await order.save()
   *   await db.transaction(async () => { await audit.save() }) // a savepoint
   * })
   */
  async transaction<T>(fn: () => Promise<T>, options: RunOptions = {}): Promise<T> {
    const current = this.#transactions.getStore()
    if (current !== undefined) return this.#savepoint(current, fn, options)
    // Inside session(): the transaction runs on the pinned connection, which session() releases.
    const pinned = this.#pinned.getStore()
    const session = pinned ?? (await this.#driver.acquire())
    const state: TransactionState = {
      session,
      depth: 1,
      shared: { tenantId: undefined, ended: false, afterCommit: [] },
      childOpen: false,
    }
    let broken = false
    let result: T
    try {
      await this.#execute(session, plain('BEGIN'))
      await this.#applyTenant(state, options.tenantId)
      result = await this.#transactions.run(state, fn)
      // Mark the end *before* COMMIT/ROLLBACK: work still running inside (an un-awaited promise,
      // a sibling in Promise.all) must not slip in after them and run in autocommit mode.
      state.shared.ended = true
      await this.#execute(session, plain('COMMIT'))
    } catch (error) {
      state.shared.ended = true
      broken = await this.#rollback(session)
      throw error
    } finally {
      if (pinned === undefined) session.release(broken)
    }
    // After the connection went back to the pool: a callback that queries (the queue pushing a
    // job) must not wait for the connection this transaction held (SQLite has only one).
    await runAfterCommit(state.shared.afterCommit)
    return result
  }

  /**
   * Run `fn` with one connection pinned to its async call chain, without opening a transaction:
   * every statement and transaction inside uses that same connection, and it is released when
   * `fn` settles. Session-scoped state needs this, such as MySQL's `GET_LOCK` / `RELEASE_LOCK` and
   * PostgreSQL's session advisory locks, which the migrator holds around a whole run. Nested calls
   * (or a call inside a transaction) reuse what is already pinned.
   *
   * @example
   * await db.session(async () => {
   *   await db.run(sql`SELECT GET_LOCK(${'migrate'}, ${10})`)
   *   try { await work() } finally { await db.run(sql`SELECT RELEASE_LOCK(${'migrate'})`) }
   * })
   */
  async session<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#transactions.getStore() !== undefined || this.#pinned.getStore() !== undefined)
      return fn()
    const session = await this.#driver.acquire()
    let broken = false
    try {
      return await this.#pinned.run(session, fn)
    } catch (error) {
      broken = isConnectionFailure(error)
      throw error
    } finally {
      session.release(broken)
    }
  }

  /**
   * Run `callback` once the current transaction has committed (Laravel's `DB::afterCommit`):
   * the queue uses it so a job dispatched inside a transaction is pushed only when the data it
   * needs is visible to workers. Outside a transaction the callback runs now. A rollback (of the
   * transaction, or of the savepoint the callback was registered in) drops it.
   *
   * Callbacks run one after another, after COMMIT, and must handle their own errors: one that
   * throws is ignored, because the transaction has already committed and must not report a
   * failure.
   *
   * @example
   * await db.transaction(async () => {
   *   await order.save()
   *   await db.afterCommit(() => notify(order.id))
   * })
   */
  async afterCommit(callback: () => Promise<void>): Promise<void> {
    const state = this.#transactions.getStore()
    if (state === undefined || state.shared.ended) {
      await runAfterCommit([callback])
      return
    }
    state.shared.afterCommit.push(callback)
  }

  /**
   * Close the underlying driver. Safe to call twice.
   *
   * @example
   * await db.close()
   */
  close(): Promise<void> {
    return this.#driver.close()
  }

  async #savepoint<T>(
    parent: TransactionState,
    fn: () => Promise<T>,
    options: RunOptions,
  ): Promise<T> {
    if (parent.childOpen) {
      throw new Error(
        'Two nested transactions are running at the same time on one connection (for example inside Promise.all). ' +
          'Savepoints are a stack, so run nested transactions one after another.',
      )
    }
    const name = `sv_${parent.depth}`
    const child: TransactionState = {
      session: parent.session,
      depth: parent.depth + 1,
      shared: parent.shared,
      childOpen: false,
    }
    // ROLLBACK TO SAVEPOINT also undoes a set_config made inside the savepoint; remember what was
    // set before, so the next tenant statement sets it again instead of running without a tenant.
    const tenantBefore = parent.shared.tenantId
    // Callbacks registered inside a savepoint that rolls back belong to undone work: drop them.
    const callbacksBefore = parent.shared.afterCommit.length
    parent.childOpen = true
    try {
      await this.#executeIn(parent, plain(`SAVEPOINT ${name}`))
      await this.#applyTenant(child, options.tenantId)
      try {
        const result = await this.#transactions.run(child, fn)
        await this.#executeIn(parent, plain(`RELEASE SAVEPOINT ${name}`))
        return result
      } catch (error) {
        // Undo only this level, then drop the savepoint; the outer transaction carries on.
        await this.#executeIn(parent, plain(`ROLLBACK TO SAVEPOINT ${name}`))
        parent.shared.tenantId = tenantBefore
        parent.shared.afterCommit.length = callbacksBefore
        await this.#executeIn(parent, plain(`RELEASE SAVEPOINT ${name}`))
        throw error
      }
    } finally {
      parent.childOpen = false
    }
  }

  /**
   * Run inside a transaction, unless it already ended. Found by the spike: with
   * `Promise.all([transaction(a), transaction(b)])`, b's failure rolls the outer transaction
   * back while a is still running; without this check a's remaining statements ran in
   * autocommit mode on a connection already handed back to the pool.
   */
  async #executeIn(state: TransactionState, rendered: RenderedSql): Promise<QueryResult> {
    if (state.shared.ended) {
      throw new Error(
        'This transaction has already finished (committed or rolled back), so this statement was not run. Await all work inside transaction(…) before it returns.',
      )
    }
    return this.#execute(state.session, rendered)
  }

  /** Set the tenant once per transaction; refuse a second, different tenant. */
  async #applyTenant(state: TransactionState, tenantId: string | undefined): Promise<void> {
    if (tenantId === undefined || this.grammar.dialect !== 'postgres') return
    if (state.shared.tenantId === tenantId) return
    if (state.shared.tenantId !== undefined) {
      throw new TenantMismatchError(
        'this transaction',
        `it already belongs to tenant ${state.shared.tenantId}, not ${tenantId}`,
      )
    }
    // `true` = transaction-local (ADR-0007 rule 3). A session-level SET would leak through pooling.
    await this.#executeIn(state, {
      sql: "SELECT set_config('app.tenant_id', $1, true)",
      params: [tenantId],
    })
    state.shared.tenantId = tenantId
  }

  /** Roll back, reporting whether the connection is unusable afterwards. */
  async #rollback(session: DriverSession): Promise<boolean> {
    try {
      await this.#execute(session, plain('ROLLBACK'))
      return false
    } catch {
      // If even ROLLBACK fails the connection state is unknown: destroy it rather than reuse it.
      return true
    }
  }

  async #execute(session: DriverSession, rendered: RenderedSql): Promise<QueryResult> {
    const started = performance.now()
    const result = await session.run(rendered.sql, rendered.params)
    const event: QueryEvent = {
      sql: rendered.sql,
      params: rendered.params,
      durationMs: performance.now() - started,
    }
    for (const listener of this.#listeners) listener(event)
    return result
  }
}

/** Run after-commit callbacks in order; a throwing one never stops the rest (see afterCommit). */
async function runAfterCommit(callbacks: readonly (() => Promise<void>)[]): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback()
    } catch {
      // Ignored by design: the transaction already committed (callbacks report their own errors).
    }
  }
}

/** SQL the connection writes itself (transaction control): no values, no identifiers from input. */
function plain(text: string): RenderedSql {
  return { sql: text, params: [] }
}

/** Errors that mean "this connection is dead", as opposed to "this statement was wrong". */
function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /connection (terminated|closed)|ECONNRESET|database is closed/i.test(message)
}
