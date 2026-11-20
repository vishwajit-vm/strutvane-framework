/**
 * Which connection models use, and the named connections an app declares (CONSISTENCY #132,
 * RFC-0007).
 *
 * Laravel resolves a model's connection through a resolver the framework sets at boot. Strutvane
 * has two ways in, checked in this order:
 *
 * 1. **The running application's connections.** Every request and console command of an
 *    `Application` runs inside {@link runWithConnections}, so a model resolves *that* app's
 *    connection, lazily, even when two apps live in one process (tests) and never each other's.
 * 2. **Process-wide connections** set with {@link useConnection}: what `node strut db:seed` and
 *    scripts without an application use.
 *
 * `DB_*` is the **default** connection (no name, or the reserved name `default`). Every other
 * connection has a name (`db.connection('reports')`, a model's `connection: 'reports'` option),
 * and a name nobody declared is refused, never silently mapped to the default: a typo must not
 * write to the wrong database.
 *
 * Importing a model never opens a database: the connection is looked up when a query runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { OrmUsageError } from '../orm/errors.ts'
import type { AfterCommitCallback, Connection } from './connection.ts'

/** The name of the `DB_*` connection; never usable as an extra connection's name. */
export const DEFAULT_CONNECTION = 'default'

/** A connection name: lowercase letters, digits and `_`, starting with a letter (it becomes `DB_<NAME>_`). */
const CONNECTION_NAME = /^[a-z][a-z0-9_]{0,62}$/

/**
 * How the code inside {@link runWithConnections} finds connections: the default one, and named
 * ones by name. Both are called on each query, so they can open the connection on first use.
 *
 * @example
 * const resolver: ConnectionResolver = { default: () => main, named: (name) => manager.connection(name) }
 */
export interface ConnectionResolver {
  readonly default: () => Connection
  /** Throw (with a fix-it message) for a name the app does not declare. */
  readonly named: (name: string) => Connection
}

let current: Connection | undefined
const processNamed = new Map<string, Connection>()
const scoped = new AsyncLocalStorage<ConnectionResolver>()

/**
 * Is `name` a valid connection name? `default` counts: it means the `DB_*` connection.
 *
 * @example
 * isConnectionName('reports') // true
 * isConnectionName('Reports') // false
 */
export function isConnectionName(name: string): boolean {
  return CONNECTION_NAME.test(name)
}

/**
 * Throw `invalid_connection_name` unless `name` is a valid connection name.
 *
 * @example
 * assertConnectionName('reports')
 */
export function assertConnectionName(name: unknown): asserts name is string {
  if (typeof name === 'string' && isConnectionName(name)) return
  throw new OrmUsageError(
    'invalid_connection_name',
    `${JSON.stringify(String(name))} is not a database connection name. Use lowercase letters, digits and _, starting with a letter (e.g. "reports"); its keys in .env are DB_<NAME>_*.`,
  )
}

/**
 * Make `connection` one every model can use outside an application (seeders, scripts): the
 * default one, or the one called `name`.
 *
 * @example
 * useConnection(new Connection(sqliteDriver(':memory:')))
 * useConnection(new Connection(pgDriver({ connectionString })), 'reports')
 */
export function useConnection(connection: Connection, name?: string): void {
  if (name === undefined || name === DEFAULT_CONNECTION) {
    current = connection
    return
  }
  assertConnectionName(name)
  processNamed.set(name, connection)
}

/**
 * Forget the process-wide connection called `name` (the default one without a name). The
 * connection is not closed: whoever opened it closes it.
 *
 * @example
 * forgetConnection('reports')
 */
export function forgetConnection(name?: string): void {
  if (name === undefined || name === DEFAULT_CONNECTION) current = undefined
  else processNamed.delete(name)
}

/**
 * Run `work` with models resolving their default connection through `resolve` (called on each
 * query, so it can create the connection on first use). A named connection is refused inside
 * `work`; use {@link runWithConnections} to provide them.
 *
 * @example
 * await runWithConnection(() => app.make(DatabaseConnectionToken), () => Post.all())
 */
export function runWithConnection<TResult>(
  resolve: () => Connection,
  work: () => TResult,
): TResult {
  return runWithConnections(
    {
      default: resolve,
      named: (name) => {
        throw unknownConnection(name, 'This code runs with only a default connection.')
      },
    },
    work,
  )
}

/**
 * Run `work` with models resolving the default and named connections through `resolver`. The
 * application wraps every request and command in this; it wins over {@link useConnection} for
 * everything inside `work`.
 *
 * @example
 * await runWithConnections({ default: () => main, named: (name) => manager.connection(name) }, work)
 */
export function runWithConnections<TResult>(
  resolver: ConnectionResolver,
  work: () => TResult,
): TResult {
  return scoped.run(resolver, work)
}

/**
 * The default connection models use. Throws a friendly error when there is none.
 *
 * @example
 * await defaultConnection().run(sql`SELECT 1`)
 */
export function defaultConnection(): Connection {
  const resolver = scoped.getStore()
  if (resolver !== undefined) return resolver.default()
  if (current === undefined) {
    throw new OrmUsageError(
      'no_connection',
      'No database connection is set yet. Inside an application, models use the connection from config/database.ts and DB_* in .env; outside one (a script), call useConnection(connection) first.',
    )
  }
  return current
}

/**
 * The connection called `name` (the default one without a name, or with `default`). Inside an
 * application it is that app's connection, opened on first use; outside one, the connection a
 * script set with `useConnection(connection, name)`.
 *
 * @example
 * await connectionNamed('reports').run(sql`SELECT 1`)
 */
export function connectionNamed(name?: string): Connection {
  if (name === undefined || name === DEFAULT_CONNECTION) return defaultConnection()
  assertConnectionName(name)
  const resolver = scoped.getStore()
  if (resolver !== undefined) return resolver.named(name)
  const connection = processNamed.get(name)
  if (connection !== undefined) return connection
  throw unknownConnection(
    name,
    'Outside an application (a script or a seeder run), call useConnection(connection, name) first.',
  )
}

function unknownConnection(name: string, context: string): OrmUsageError {
  return new OrmUsageError(
    'unknown_connection',
    `There is no database connection called "${name}". ${context} In an app, declare it in config/database.ts under connections and set its DB_${name.toUpperCase()}_* keys in .env.`,
  )
}

/**
 * Run `fn` in a transaction on the default connection (Laravel's `DB::transaction`).
 *
 * @example
 * await transaction(async () => { await post.save(); await tag.save() })
 */
export function transaction<T>(fn: () => Promise<T>): Promise<T> {
  return defaultConnection().transaction(fn)
}

/**
 * Run `callback` once the current transaction on the default connection commits (at once outside
 * a transaction; never after a rollback). Laravel's `DB::afterCommit`.
 *
 * @example
 * await transaction(async () => {
 *   await order.save()
 *   await afterCommit(() => notify(order))
 * })
 */
export function afterCommit(callback: AfterCommitCallback): Promise<void> {
  return defaultConnection().afterCommit(callback)
}

/**
 * What {@link db} offers.
 *
 * @example
 * const reports = db.connection('reports')
 */
export interface DatabaseHelper {
  /** The connection called `name`, or the default (`DB_*`) one without a name. */
  connection(name?: string): Connection
  /** Run `fn` in a transaction on the default connection. */
  transaction<T>(fn: () => Promise<T>): Promise<T>
  /** Run `callback` once the default connection's current transaction commits. */
  afterCommit(callback: AfterCommitCallback): Promise<void>
}

/**
 * The app's databases, Laravel's `DB::`. `db.connection('reports')` is the connection declared
 * as `reports` in `config/database.ts` (its keys are `DB_REPORTS_*`); a transaction on one
 * connection never covers another.
 *
 * @example
 * await db.connection('reports').run(sql`SELECT count(*) AS n FROM visits`)
 * await db.connection('reports').transaction(async () => { … })
 */
export const db: DatabaseHelper = Object.freeze({
  connection: (name?: string): Connection => connectionNamed(name),
  transaction: <T>(fn: () => Promise<T>): Promise<T> => transaction(fn),
  afterCommit: (callback: AfterCommitCallback): Promise<void> => afterCommit(callback),
})
