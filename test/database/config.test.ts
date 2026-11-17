/**
 * `DB_*` settings (CONSISTENCY #14, #40, #42, #43, #96): every value, the aliases, the defaults,
 * every problem reported at once without echoing secrets, and real connections on each engine.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { EnvValidationError } from '../../src/core/index.ts'
import {
  DEFAULT_SQLITE_FILE,
  databaseSettings,
  describeDatabase,
  openDatabase,
} from '../../src/database/config.ts'
import { trustedSql } from '../../src/database/sql/fragment.ts'
import { serverDatabase, skipReason } from '../helpers/server-database.ts'

const root = mkdtempSync(join(tmpdir(), 'sv-db-config-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const problems = (env: Record<string, string>): string[] => {
  try {
    databaseSettings(env, root)
  } catch (error) {
    if (error instanceof EnvValidationError) return error.problems.map((p) => p.key)
    throw error
  }
  return []
}

describe('databaseSettings', () => {
  test('MySQL is the default, with local-friendly values', () => {
    expect(databaseSettings({}, root)).toMatchObject({
      connection: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'strutvane',
      username: 'root',
    })
  })

  test('pgsql, its postgres alias, mariadb and sqlite', () => {
    expect(databaseSettings({ DB_CONNECTION: 'pgsql' }, root)).toMatchObject({
      port: 5432,
      username: 'postgres',
    })
    expect(databaseSettings({ DB_CONNECTION: 'postgres' }, root).connection).toBe('pgsql')
    expect(databaseSettings({ DB_CONNECTION: 'MariaDB' }, root).connection).toBe('mariadb')
    const sqlite = databaseSettings({ DB_CONNECTION: 'sqlite' }, root)
    expect(sqlite.filename).toBe(resolve(root, DEFAULT_SQLITE_FILE))
    expect(
      databaseSettings({ DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, root).filename,
    ).toBe(':memory:')
  })

  test('DB_URL names the engine when DB_CONNECTION is unset; a mismatch is refused', () => {
    expect(databaseSettings({ DB_URL: 'postgres://u:p@db:5432/app' }, root).connection).toBe(
      'pgsql',
    )
    expect(problems({ DB_CONNECTION: 'mysql', DB_URL: 'postgres://u:p@db/app' })).toEqual([
      'DB_URL',
    ])
    expect(problems({ DB_URL: 'not a url' })).toEqual(['DB_URL'])
    expect(problems({ DB_CONNECTION: 'mysql', DB_URL: 'redis://x' })).toEqual(['DB_URL'])
  })

  test('socket, TLS mode and CA file; every problem at once', () => {
    const ca = join(root, 'ca.pem')
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\n')
    expect(
      databaseSettings(
        {
          DB_SOCKET: '/var/run/mysqld/mysqld.sock',
          DB_SSLMODE: 'VERIFY-FULL',
          DB_SSL_CA: 'ca.pem',
        },
        root,
      ),
    ).toMatchObject({
      socket: '/var/run/mysqld/mysqld.sock',
      sslMode: 'verify-full',
      sslCa: '-----BEGIN CERTIFICATE-----\n',
    })
    expect(
      problems({
        DB_CONNECTION: 'oracle',
        DB_PORT: '99999',
        DB_SSLMODE: 'maybe',
        DB_SSL_CA: 'missing.pem',
      }),
    ).toEqual(['DB_CONNECTION', 'DB_PORT', 'DB_SSLMODE', 'DB_SSL_CA'])
  })

  test('the description never contains the password', () => {
    const settings = databaseSettings({ DB_PASSWORD: 's3cret', DB_SSLMODE: 'require' }, root)
    expect(describeDatabase(settings)).toBe('mysql://root@127.0.0.1:3306/strutvane (TLS: require)')
    expect(
      describeDatabase(databaseSettings({ DB_URL: 'mysql://app:s3cret@db:3306/app' }, root)),
    ).not.toContain('s3cret')
    expect(
      describeDatabase(
        databaseSettings({ DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, root),
      ),
    ).toBe('sqlite::memory:')
  })
})

describe('openDatabase', () => {
  const one = trustedSql([{ kind: 'text', text: 'SELECT 1 AS one' }])

  test('SQLite in memory', async () => {
    const connection = await openDatabase(
      databaseSettings({ DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, root),
    )
    try {
      expect(Number((await connection.run(one)).rows[0]?.['one'])).toBe(1)
    } finally {
      await connection.close()
    }
  })

  test.each([
    ['mysql', 'mysql'],
    ['mariadb', 'mariadb'],
    ['postgres', 'pgsql'],
  ] as const)('%s from DB_URL, also as a migration connection', async (engine, connectionName) => {
    if (skipReason(engine) !== undefined) return
    const db = await serverDatabase(engine)
    try {
      const settings = databaseSettings({ DB_CONNECTION: connectionName, DB_URL: db.url }, root)
      for (const options of [{}, { forMigrations: { lockTimeoutMs: 5000 } }]) {
        const connection = await openDatabase(settings, options)
        try {
          expect(Number((await connection.run(one)).rows[0]?.['one'])).toBe(1)
          // The server decides the grammar: MariaDB is detected whatever DB_CONNECTION says.
          expect(connection.grammar.dialect).toBe(engine)
        } finally {
          await connection.close()
        }
      }
    } finally {
      await db.drop()
    }
  })

  test('MySQL from discrete settings', async () => {
    if (skipReason('mysql') !== undefined) return
    const db = await serverDatabase('mysql')
    try {
      const url = new URL(db.url)
      const connection = await openDatabase(
        databaseSettings(
          {
            DB_HOST: url.hostname,
            DB_PORT: url.port,
            DB_DATABASE: url.pathname.slice(1),
            DB_USERNAME: decodeURIComponent(url.username),
            DB_PASSWORD: decodeURIComponent(url.password),
          },
          root,
        ),
      )
      try {
        expect(Number((await connection.run(one)).rows[0]?.['one'])).toBe(1)
      } finally {
        await connection.close()
      }
    } finally {
      await db.drop()
    }
  })
})
