/**
 * Real database engines for tests: PGlite (Postgres in WASM) and libSQL (SQLite in memory).
 * No mocks for SQL (engineering standards): every data test runs on both.
 */
import { PGlite } from '@electric-sql/pglite'
import { createClient } from '@libsql/client'
import { vi } from 'vitest'
import { type LibsqlLike, libsqlDatabase, pgliteDatabase } from '../../src/database/drivers.ts'
import type { Database, Dialect } from '../../src/database/types.ts'

// Every suite that imports this helper starts PGlite (a WASM Postgres) and usually plans
// migrations with drizzle-kit, often once per test. Each takes seconds on a quiet machine and far
// longer when the full gate runs every core at once (the real-server suites, the replay sandbox's
// child processes and the coverage instrumentation all compete), which is how these suites hit
// the 60 s default. The work itself is bounded, so give it a realistic ceiling instead of
// changing what it checks (the same values test/helpers/server-database.ts uses).
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 })

export const DIALECTS: readonly Dialect[] = ['postgres', 'sqlite']

/** A fresh, empty database of the given dialect. */
export async function createDatabase(dialect: Dialect): Promise<Database> {
  if (dialect === 'postgres') return pgliteDatabase(await PGlite.create())
  // intMode 'bigint': 64-bit integers are never silently rounded (the default throws above 2^53).
  const client = createClient({ url: ':memory:', intMode: 'bigint' })
  await client.execute('PRAGMA foreign_keys = ON')
  return libsqlDatabase(client as unknown as LibsqlLike)
}

/** Column info used by schema assertions. */
export interface ColumnInfo {
  readonly type: string
  readonly nullable: boolean
}

/** Introspect a table's columns. */
export async function columns(db: Database, table: string): Promise<Record<string, ColumnInfo>> {
  if (db.dialect === 'postgres') {
    const rows = await db.query<{
      column_name: string
      data_type: string
      character_maximum_length: number | null
      numeric_precision: number | null
      numeric_scale: number | null
      is_nullable: 'YES' | 'NO'
    }>(
      `select column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable
         from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [table],
    )
    return Object.fromEntries(
      rows.map((c) => {
        let type = c.data_type
        if (type === 'character varying') type = `varchar(${c.character_maximum_length})`
        if (type === 'numeric') type = `numeric(${c.numeric_precision},${c.numeric_scale})`
        return [c.column_name, { type, nullable: c.is_nullable === 'YES' }]
      }),
    )
  }
  const rows = await db.query<{ name: string; type: string; notnull: number }>(
    'select name, type, "notnull" from pragma_table_info(?)',
    [table],
  )
  return Object.fromEntries(
    rows.map((c) => [c.name, { type: c.type.toLowerCase(), nullable: Number(c.notnull) === 0 }]),
  )
}

/** Index names of a table. */
export async function indexes(db: Database, table: string): Promise<string[]> {
  const rows =
    db.dialect === 'postgres'
      ? await db.query<{ name: string }>(
          'select indexname as name from pg_indexes where tablename = $1 order by 1',
          [table],
        )
      : await db.query<{ name: string }>(
          `select name from sqlite_master where type = 'index' and tbl_name = ? and name not like 'sqlite_autoindex%' order by 1`,
          [table],
        )
  return rows.map((r) => r.name)
}

/** Table names (excluding engine internals). */
export async function tables(db: Database): Promise<string[]> {
  const rows =
    db.dialect === 'postgres'
      ? await db.query<{ name: string }>(
          `select table_name as name from information_schema.tables where table_schema = 'public' order by 1`,
        )
      : await db.query<{ name: string }>(
          `select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by 1`,
        )
  return rows.map((r) => r.name)
}

/** Placeholder for the dialect (`$n` / `?`). */
export const ph = (db: Database, n: number): string => (db.dialect === 'postgres' ? `$${n}` : '?')
