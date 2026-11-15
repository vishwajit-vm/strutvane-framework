/**
 * Migrations run on their own connection settings. The app pool caps every statement at 5 s
 * (a public API must not hold connections), but a migration that rewrites a large table or
 * builds an index legitimately runs longer, and killing it half way leaves a deploy stuck. The
 * opposite risk is a migration that waits forever for a lock held by live traffic, while every
 * request queues behind its own lock request: `lock_timeout` (default 10 s) makes it fail fast
 * and retryable instead.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { EnvValidationError } from '../../src/core/index.ts'
import { pgPoolOptions } from '../../src/database/connect.ts'
import {
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  migrationConnection,
  migrationTarget,
} from '../../src/runtime/migrations.ts'
import type { LoadedProject } from '../../src/runtime/project.ts'

const saved = process.env['DB_MIGRATION_LOCK_TIMEOUT']
afterEach(() => {
  if (saved === undefined) delete process.env['DB_MIGRATION_LOCK_TIMEOUT']
  else process.env['DB_MIGRATION_LOCK_TIMEOUT'] = saved
})

const project = (database: Record<string, unknown>): LoadedProject => ({
  root: process.cwd(),
  config: { database },
  providers: [],
  models: [],
  resources: [],
  routes: [],
})

const postgres = { default: 'postgres', connection: { url: 'postgres://a:b@db:5432/app' } }

describe('migrations: their own Postgres connection settings', () => {
  it('no statement timeout, a 10 s lock timeout, sent as session settings', () => {
    delete process.env['DB_MIGRATION_LOCK_TIMEOUT']
    const target = migrationTarget(project(postgres))
    expect(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS).toBe(10_000)
    const pool = pgPoolOptions(target.connection as Parameters<typeof pgPoolOptions>[0])
    // Sent with -c, so a role or database default (ALTER ROLE … SET statement_timeout) cannot
    // bring the API's limit back for the migration session.
    expect(pool['options']).toBe('-c statement_timeout=0 -c lock_timeout=10000')
    expect(pool['statement_timeout']).toBeUndefined()
    // No client-side cap either: a long index build is not a frozen server.
    expect(pool['query_timeout']).toBeUndefined()
    expect(pool['max']).toBe(1)
  })

  it('even when config/database.ts set a pool statement timeout for the app', () => {
    const target = migrationTarget(
      project({ ...postgres, connection: { ...postgres.connection, pool: { max: 20 } } }),
    )
    const pool = pgPoolOptions(target.connection as Parameters<typeof pgPoolOptions>[0])
    expect(pool['options']).toContain('statement_timeout=0')
    expect(pool['max']).toBe(1)
  })

  it('DB_MIGRATION_LOCK_TIMEOUT sets the lock timeout (ms, or with a unit)', () => {
    for (const [value, ms] of [
      ['2500', 2500],
      ['30s', 30_000],
      ['250ms', 250],
      ['2min', 120_000],
      ['0', 0],
    ] as const) {
      process.env['DB_MIGRATION_LOCK_TIMEOUT'] = value
      const pool = pgPoolOptions(
        migrationTarget(project(postgres)).connection as Parameters<typeof pgPoolOptions>[0],
      )
      expect(pool['options'], value).toBe(`-c statement_timeout=0 -c lock_timeout=${ms}`)
    }
  })

  it('a malformed DB_MIGRATION_LOCK_TIMEOUT is an invalid environment naming the key', () => {
    for (const value of ['', 'soon', '-1', '1.5s', '10 hours']) {
      process.env['DB_MIGRATION_LOCK_TIMEOUT'] = value
      const error = (() => {
        try {
          migrationTarget(project(postgres))
          return undefined
        } catch (e) {
          return e
        }
      })()
      expect(error, value).toBeInstanceOf(EnvValidationError)
      expect((error as EnvValidationError).problems[0]?.key).toBe('DB_MIGRATION_LOCK_TIMEOUT')
    }
  })

  it('SQLite and PGlite connections are unchanged (no server-side timeouts to lift)', () => {
    const sqlite = { driver: 'sqlite', url: ':memory:' } as const
    expect(migrationConnection(sqlite)).toEqual(sqlite)
    expect(migrationConnection({ driver: 'pglite' })).toEqual({ driver: 'pglite' })
  })
})
