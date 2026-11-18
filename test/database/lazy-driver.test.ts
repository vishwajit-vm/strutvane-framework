/**
 * The lazy driver behind an application's connection: opened by the first statement, once, and
 * every failure scenario of that (a failed open, a close while opening, use after close) handled.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { databaseSettings, openDatabaseLazily } from '../../src/database/config.ts'
import { Connection } from '../../src/database/db/connection.ts'
import type { Driver, DriverSession } from '../../src/database/db/driver.ts'
import { lazyDriver } from '../../src/database/db/lazy-driver.ts'
import { sql } from '../../src/database/index.ts'

const folders: string[] = []
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 5 })
})

/** A fake engine that counts opens, sessions and closes. */
function fakeEngine(): { driver: Driver; closes: number; sessions: number } {
  const state = { closes: 0, sessions: 0, driver: undefined as unknown as Driver }
  const session: DriverSession = {
    run: async () => ({ rows: [{ one: 1 }], rowsAffected: 0 }),
    release: () => undefined,
  }
  state.driver = {
    dialect: 'sqlite',
    acquire: async () => {
      state.sessions += 1
      return session
    },
    close: async () => {
      state.closes += 1
    },
  }
  return state
}

describe('lazyDriver', () => {
  test('building it opens nothing; the first statement opens the engine exactly once', async () => {
    const engine = fakeEngine()
    let opens = 0
    const driver = lazyDriver({
      dialect: 'sqlite',
      open: async () => {
        opens += 1
        return engine.driver
      },
    })
    expect(opens).toBe(0)
    expect(driver.opened).toBe(false)
    const connection = new Connection(driver)
    await Promise.all([1, 2, 3, 4].map(() => connection.run(sql`SELECT 1`)))
    expect(opens).toBe(1)
    expect(engine.sessions).toBe(4)
    expect(driver.opened).toBe(true)
  })

  test('a failed open reaches the waiting statements, and the next statement tries again', async () => {
    const engine = fakeEngine()
    let attempt = 0
    const driver = lazyDriver({
      dialect: 'sqlite',
      open: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('ECONNREFUSED')
        return engine.driver
      },
    })
    const [a, b] = await Promise.allSettled([driver.acquire(), driver.acquire()])
    expect(a).toMatchObject({ status: 'rejected', reason: new Error('ECONNREFUSED') })
    expect(b).toMatchObject({ status: 'rejected' })
    expect(attempt).toBe(1)
    await expect(driver.acquire()).resolves.toBeDefined()
    expect(attempt).toBe(2)
  })

  test('closing a driver that never opened opens nothing; closing twice is safe', async () => {
    let opens = 0
    const driver = lazyDriver({
      dialect: 'postgres',
      open: async () => {
        opens += 1
        return fakeEngine().driver
      },
    })
    await driver.close()
    await driver.close()
    expect(opens).toBe(0)
    await expect(driver.acquire()).rejects.toThrow(/closed/)
    expect(opens).toBe(0)
  })

  test('close() while the engine is opening closes it once it has opened, and hands out nothing', async () => {
    const engine = fakeEngine()
    let finishOpen: (driver: Driver) => void = () => undefined
    const driver = lazyDriver({
      dialect: 'sqlite',
      open: () =>
        new Promise<Driver>((resolve) => {
          finishOpen = resolve
        }),
    })
    const waiting = driver.acquire()
    const closing = driver.close()
    finishOpen(engine.driver)
    await expect(waiting).rejects.toThrow(/closed while it was opening/)
    await closing
    expect(engine.sessions).toBe(0)
    expect(engine.closes).toBeGreaterThanOrEqual(1)
  })

  test('closing an opened engine closes it; use after close is refused with what to do', async () => {
    const engine = fakeEngine()
    const driver = lazyDriver({ dialect: 'sqlite', open: async () => engine.driver })
    await driver.acquire()
    await driver.close()
    expect(engine.closes).toBe(1)
    await expect(driver.acquire()).rejects.toThrow(/Boot the application again/)
  })

  test('a close after a failed open has nothing to close', async () => {
    const driver = lazyDriver({
      dialect: 'sqlite',
      open: async () => {
        throw new Error('down')
      },
    })
    await expect(driver.acquire()).rejects.toThrow('down')
    await expect(driver.close()).resolves.toBeUndefined()
  })
})

describe('openDatabaseLazily', () => {
  test('SQLite: the file is created by the first query, not by building the connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sv-lazy-sqlite-'))
    folders.push(root)
    const connection = openDatabaseLazily(
      databaseSettings({ DB_CONNECTION: 'sqlite', DB_DATABASE: 'app.sqlite' }, root),
    )
    expect(existsSync(join(root, 'app.sqlite'))).toBe(false)
    const { rows } = await connection.run(sql`SELECT 1 AS one`)
    expect(rows).toEqual([{ one: 1 }])
    expect(existsSync(join(root, 'app.sqlite'))).toBe(true)
    await connection.close()
  })

  test.each([
    ['mysql', 'mysql', false],
    ['mariadb', 'mariadb', false],
    ['pgsql', 'postgres', true],
    ['sqlite', 'sqlite', true],
  ] as const)(
    '%s: the grammar is fixed up front (%s, RETURNING on inserts: %s)',
    (name, dialect, returning) => {
      const connection = openDatabaseLazily(
        databaseSettings({ DB_CONNECTION: name, DB_DATABASE: ':memory:' }, tmpdir()),
      )
      expect(connection.grammar.dialect).toBe(dialect)
      // The MySQL family runs the grammar every MySQL and MariaDB version accepts (#43).
      expect(connection.grammar.supportsReturning).toBe(returning)
    },
  )

  test('a server that is down fails the first query, not the build', async () => {
    const connection = openDatabaseLazily(
      databaseSettings({ DB_CONNECTION: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: '1' }, tmpdir()),
    )
    await expect(connection.run(sql`SELECT 1`)).rejects.toThrow()
    await connection.close()
  })
})
