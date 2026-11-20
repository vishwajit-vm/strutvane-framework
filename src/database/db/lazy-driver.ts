/**
 * A driver that opens its engine on first use: Laravel's lazy connection.
 *
 * **Why:** an application builds its database connection when it boots, but many requests and
 * commands never touch the database (`/up`, `route:list`, a cached page). Opening the engine there
 * would make every one of them depend on the database being reachable, and would create a SQLite
 * file or a server pool for nothing. With this wrapper, building the connection is free (no I/O);
 * the engine is opened by the first statement, exactly once, however many statements race for it.
 *
 * **Failure scenarios, handled deliberately:**
 * - opening fails (server down, bad password): the error goes to the statements that waited for
 *   it, and the next statement tries again (a retry is idempotent: nothing was opened);
 * - `close()` while opening: the engine is closed as soon as it has opened, so nothing leaks;
 * - use after `close()`: refused with a message that says what to do, never silently reopened.
 *
 * The dialect (and so the SQL grammar) must be known before the engine opens, because the ORM
 * compiles statements before running them. Callers pass the dialect the settings name; see
 * `openDatabaseLazily` for how the MySQL family stays correct without asking the server first.
 *
 * @module
 */
import type { Dialect } from '../sql/grammar.ts'
import type { Driver, DriverSession } from './driver.ts'

/**
 * What a lazy driver needs: the dialect it will speak, and how to open the real engine.
 *
 * @example
 * const options: LazyDriverOptions = { dialect: 'sqlite', open: async () => sqliteDriver(file) }
 */
export interface LazyDriverOptions {
  readonly dialect: Dialect
  /** See {@link Driver.insertReturning}; fixed before the engine opens. */
  readonly insertReturning?: boolean
  /** Open the real engine. Called on the first `acquire()`, and again only if it failed. */
  readonly open: () => Promise<Driver>
  /**
   * Checks to run on the freshly opened engine before any statement uses it (the PostgreSQL
   * runtime-role check). If it throws, the engine is closed and the error goes to the waiting
   * statements; the next statement opens and checks again.
   */
  readonly afterOpen?: (driver: Driver) => Promise<void>
}

/**
 * Wrap an engine so it opens on the first statement instead of when the connection is built.
 *
 * @example
 * const connection = new Connection(lazyDriver({ dialect: 'sqlite', open: async () => sqliteDriver(file) }))
 * // nothing is opened yet; the first query opens the file
 */
export function lazyDriver(options: LazyDriverOptions): Driver & { readonly opened: boolean } {
  let opening: Promise<Driver> | undefined
  let opened: Driver | undefined
  let closed = false

  const engine = (): Promise<Driver> => {
    opening ??= options.open().then(
      async (driver) => {
        if (options.afterOpen !== undefined) {
          try {
            await options.afterOpen(driver)
          } catch (error) {
            // Fail closed and leak nothing: the engine that failed its checks is never used.
            await driver.close().catch(() => undefined)
            throw error
          }
        }
        opened = driver
        return driver
      },
      (error: unknown) => {
        // Let the next statement try again: a failed open left nothing behind to reuse.
        opening = undefined
        throw error
      },
    )
    return opening
  }

  return {
    dialect: options.dialect,
    ...(options.insertReturning === undefined ? {} : { insertReturning: options.insertReturning }),
    get opened(): boolean {
      return opened !== undefined
    },
    async acquire(): Promise<DriverSession> {
      if (closed)
        throw new Error(
          'This database connection was closed (the application shut down). Boot the application again instead of reusing a closed one.',
        )
      const driver = await engine()
      // close() may have run while the engine was opening: don't hand out a session from it.
      if (closed) {
        await driver.close()
        throw new Error('This database connection was closed while it was opening.')
      }
      return driver.acquire()
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      const pending = opening
      if (pending === undefined) return
      try {
        await (await pending).close()
      } catch {
        // Opening failed: there is nothing to close.
      }
    },
  }
}
