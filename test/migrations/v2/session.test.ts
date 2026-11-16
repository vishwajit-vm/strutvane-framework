/**
 * `Connection.session()`: one pinned connection for an async call chain, without a transaction.
 * The migrator holds its lock on it (MySQL `GET_LOCK`, PostgreSQL session advisory locks).
 */
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'vitest'
import { Connection } from '../../../src/database/db/connection.ts'
import { pgliteDriver } from '../../../src/database/db/pglite-driver.ts'
import { sqliteDriver } from '../../../src/database/db/sqlite-driver.ts'
import { sql } from '../../../src/database/sql/fragment.ts'

describe('Connection.session', () => {
  test('statements and transactions inside share the pinned connection; nesting reuses it', async () => {
    const connection = new Connection(sqliteDriver(':memory:'))
    try {
      await connection.session(async () => {
        await connection.run(sql`CREATE TABLE ${sql.id('t')} (${sql.id('n')} INTEGER)`)
        // SQLite has one connection behind a lock: a second acquire here would wait forever, so
        // these only finish because they reuse the pinned session.
        await connection.transaction(async () => {
          await connection.run(sql`INSERT INTO ${sql.id('t')} VALUES (${1})`)
          await connection.session(() =>
            connection.run(sql`INSERT INTO ${sql.id('t')} VALUES (${2})`),
          )
        })
        await connection.session(() =>
          connection.run(sql`INSERT INTO ${sql.id('t')} VALUES (${3})`),
        )
      })
      const { rows } = await connection.run(
        sql`SELECT COUNT(*) AS ${sql.id('n')} FROM ${sql.id('t')}`,
      )
      expect(Number(rows[0]?.['n'])).toBe(3)
    } finally {
      await connection.close()
    }
  })

  test('a failure inside releases the connection and rejects with the cause', async () => {
    const connection = new Connection(pgliteDriver(await PGlite.create()))
    try {
      await expect(
        connection.session(() => connection.run(sql`SELECT * FROM ${sql.id('missing')}`)),
      ).rejects.toThrow(/missing/)
      const { rows } = await connection.run(sql`SELECT 1 AS ${sql.id('one')}`)
      expect(rows).toEqual([{ one: 1 }])
    } finally {
      await connection.close()
    }
  })
})
