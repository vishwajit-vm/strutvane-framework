/**
 * ADR-0008 on every engine the ORM supports: the grammar-based policy compiler
 * (`compileFilterSql`, also behind `Builder.wherePolicy`) and the in-memory evaluator must agree
 * on every filter, on MySQL 8.4, MariaDB 11.4, PostgreSQL 18, PGlite and SQLite.
 *
 * The table comes from a migration replayed by the schema pipeline (the DDL apps get), the rows
 * from fast-check, and each generated filter runs as SQL and in memory. MySQL is the interesting
 * one: its default collations fold case and accents and its `LOWER()` is Unicode, which the
 * compiler must neutralise (binary collations, ASCII-only folding).
 */
import { PGlite } from '@electric-sql/pglite'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor, QueryFilter } from '../../src/contracts/index.ts'
import {
  canonicalBigInt,
  canonicalDate,
  canonicalDatetime,
  canonicalDecimal,
} from '../../src/data/values.ts'
import {
  Connection,
  connectMysqlFamily,
  mysqlDriver,
  pgDriver,
  pgliteDriver,
  sqliteDriver,
} from '../../src/database/index.ts'
import { SqlFragment, sql } from '../../src/database/sql/fragment.ts'
import { bindFilter } from '../../src/query/bind.ts'
import { compileFilterSql } from '../../src/query/compile-sql.ts'
import { evaluateFilter } from '../../src/query/evaluate.ts'
import { tableQueryFields } from '../../src/query/table-fields.ts'
import { findTable } from '../../src/schema/columns.ts'
import { createSchemaSql } from '../../src/schema/ddl/ddl.ts'
import { migration } from '../../src/schema/migration.ts'
import { replayMigrations } from '../../src/schema/replay.ts'
import { type ServerDatabase, serverDatabase, skipReason } from '../helpers/server-database.ts'

const replay = replayMigrations([
  {
    name: '2026_01_01_000000_create_samples_table',
    migration: migration({
      up(schema) {
        schema.create(
          'samples',
          (t) => {
            t.id()
            t.string('name', 40).nullable()
            t.integer('qty').nullable()
            t.decimal('price', 8, 2).nullable()
            t.bigInteger('big').nullable()
            t.boolean('flag').nullable()
            t.enum('kind', ['a', 'b', 'c']).nullable()
            t.date('day').nullable()
            t.timestamp('at').nullable()
            t.double('ratio').nullable()
          },
          { global: true },
        )
      },
      down(schema) {
        schema.drop('samples')
      },
    }),
  },
])
const table = findTable(replay.state, 'samples')
if (table === undefined) throw new Error('the samples table was not replayed')
const fields = tableQueryFields(table, { includeHidden: true })

const TEXT = [
  '',
  'a',
  'A',
  'ab',
  'AB',
  'Ab%',
  'a_b',
  'a%b',
  '50%',
  'é',
  'É',
  'café',
  'CAFÉ',
  'x y',
  "o'brien",
  'abc',
  'abc ',
]
const QTY = [-3, -1, 0, 1, 2, 3, 10]
const PRICE = ['-1.50', '0', '0.10', '1', '1.5', '2.25', '100']
const BIG = ['-9007199254740993', '0', '1', '9007199254740993']
const DAY = ['2024-01-01', '2024-02-29', '2025-12-31']
const AT = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z', '2026-06-30T12:00:00+02:00']
const RATIO = [-0.5, 0, 0.25, 1.5]

const maybe = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | null> =>
  fc.option(arb, { nil: null, freq: 4 })

const rowArb = fc.record({
  name: maybe(fc.constantFrom(...TEXT)),
  qty: maybe(fc.constantFrom(...QTY)),
  price: maybe(fc.constantFrom(...PRICE)),
  big: maybe(fc.constantFrom(...BIG)),
  flag: maybe(fc.boolean()),
  kind: maybe(fc.constantFrom('a', 'b', 'c')),
  day: maybe(fc.constantFrom(...DAY)),
  at: maybe(fc.constantFrom(...AT)),
  ratio: maybe(fc.constantFrom(...RATIO)),
})
type Sample = typeof rowArb extends fc.Arbitrary<infer T> ? T : never

const actorRef = (name: string) => ({ $actor: `attrs.${name}` as const })
const valueFor: Record<string, fc.Arbitrary<unknown>> = {
  name: fc.oneof(fc.constantFrom(...TEXT.filter((t) => t !== '')), fc.constant(actorRef('name'))),
  qty: fc.oneof(fc.constantFrom(...QTY), fc.constant(actorRef('qty'))),
  price: fc.constantFrom(...PRICE, '1.50', '1.505'),
  big: fc.constantFrom(...BIG),
  flag: fc.oneof(fc.boolean(), fc.constant(actorRef('flag'))),
  kind: fc.constantFrom('a', 'b', 'c', 'z'),
  day: fc.constantFrom(...DAY),
  at: fc.constantFrom(...AT),
  ratio: fc.constantFrom(...RATIO),
}
const ORDERED = ['qty', 'price', 'big', 'day', 'at', 'ratio']
const EQUATABLE = ['name', 'qty', 'price', 'big', 'flag', 'kind', 'day']
const LISTABLE = ['name', 'qty', 'big', 'kind']
const ALL = Object.keys(valueFor)

const leafArb: fc.Arbitrary<QueryFilter> = fc.oneof(
  fc.constantFrom(...EQUATABLE).chain((f) =>
    fc.record({
      op: fc.constantFrom('eq' as const, 'ne' as const),
      field: fc.constant(f),
      value: valueFor[f] as fc.Arbitrary<never>,
    }),
  ),
  fc.constantFrom(...ORDERED).chain((f) =>
    fc.record({
      op: fc.constantFrom('gt' as const, 'gte' as const, 'lt' as const, 'lte' as const),
      field: fc.constant(f),
      value: valueFor[f] as fc.Arbitrary<never>,
    }),
  ),
  fc.constantFrom(...ORDERED).chain((f) =>
    fc.record({
      op: fc.constant('between' as const),
      field: fc.constant(f),
      from: valueFor[f] as fc.Arbitrary<never>,
      to: valueFor[f] as fc.Arbitrary<never>,
    }),
  ),
  fc.constantFrom(...LISTABLE).chain((f) =>
    fc.record({
      op: fc.constantFrom('in' as const, 'nin' as const),
      field: fc.constant(f),
      values: fc.array(valueFor[f] as fc.Arbitrary<never>, { maxLength: 4 }),
    }),
  ),
  fc.record({
    op: fc.constantFrom('isNull' as const, 'isNotNull' as const),
    field: fc.constantFrom(...ALL),
  }),
  fc.record({
    op: fc.constantFrom('contains' as const, 'startsWith' as const, 'endsWith' as const),
    field: fc.constant('name'),
    value: fc.constantFrom(...TEXT),
    caseSensitive: fc.boolean(),
  }),
  fc.constantFrom({ op: 'true' as const }, { op: 'false' as const }),
)

const filterArb: fc.Arbitrary<QueryFilter> = fc.letrec<{ f: QueryFilter }>((tie) => ({
  f: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leafArb,
    fc.record({
      op: fc.constantFrom('and' as const, 'or' as const),
      filters: fc.array(tie('f'), { maxLength: 3 }),
    }),
    fc.record({ op: fc.constant('not' as const), filter: tie('f') }),
  ),
})).f

const actorArb: fc.Arbitrary<Actor> = fc.record({
  id: fc.constant('u1'),
  type: fc.constant('user' as const),
  roles: fc.constant([]),
  attrs: fc.record({
    name: maybe(fc.constantFrom(...TEXT.filter((t) => t !== ''))),
    qty: maybe(fc.constantFrom(...QTY)),
    flag: maybe(fc.boolean()),
  }),
})

/** A sample in the binder's canonical form (what the in-memory evaluator compares). */
function canonical(row: Sample, id: number): Record<string, unknown> {
  return {
    id,
    name: row.name,
    qty: row.qty,
    price: row.price === null ? null : canonicalDecimal(row.price, 2),
    big: row.big === null ? null : canonicalBigInt(row.big),
    flag: row.flag,
    kind: row.kind,
    day: row.day === null ? null : canonicalDate(row.day),
    at: row.at === null ? null : canonicalDatetime(row.at),
    ratio: row.ratio,
  }
}

/** A value as the engine stores it (DATETIME(3) on MySQL has no zone). */
function stored(dialect: string, column: string, value: unknown): unknown {
  if (value === null) return null
  if (column === 'at') {
    const iso = new Date(String(value)).toISOString()
    return dialect === 'mysql' || dialect === 'mariadb'
      ? `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
      : iso
  }
  return value
}

type EngineName = 'mysql' | 'mariadb' | 'postgres' | 'pglite' | 'sqlite'
const ENGINES: readonly { name: EngineName; skipped: string | undefined }[] = [
  { name: 'mysql', skipped: skipReason('mysql') },
  { name: 'mariadb', skipped: skipReason('mariadb') },
  { name: 'postgres', skipped: skipReason('postgres') },
  { name: 'pglite', skipped: undefined },
  { name: 'sqlite', skipped: undefined },
]

async function open(
  name: EngineName,
): Promise<{ connection: Connection; server?: ServerDatabase }> {
  switch (name) {
    case 'mysql': {
      const server = await serverDatabase('mysql')
      return { connection: new Connection(mysqlDriver({ uri: server.url })), server }
    }
    case 'mariadb': {
      const server = await serverDatabase('mariadb')
      return { connection: new Connection(await connectMysqlFamily({ uri: server.url })), server }
    }
    case 'postgres': {
      const server = await serverDatabase('postgres')
      return { connection: new Connection(pgDriver({ connectionString: server.url })), server }
    }
    case 'pglite':
      return { connection: new Connection(pgliteDriver(await PGlite.create())) }
    case 'sqlite':
      return { connection: new Connection(sqliteDriver(':memory:')) }
  }
}

const trusted = (text: string): SqlFragment => SqlFragment.trusted([{ kind: 'text', text }])

describe.each(ENGINES)('policy SQL ↔ memory on $name', ({ name, skipped }) => {
  let connection: Connection
  let server: ServerDatabase | undefined
  const records: Record<string, unknown>[] = []

  beforeAll(async () => {
    if (skipped !== undefined) return
    const opened = await open(name)
    connection = opened.connection
    server = opened.server
    const dialect = connection.grammar.dialect
    for (const statement of createSchemaSql(replay.state, dialect))
      await connection.run(trusted(statement))
    const rows = fc.sample(rowArb, { numRuns: 60, seed: 42 })
    let id = 0
    for (const row of rows) {
      id += 1
      const columns = Object.keys(row)
      const values = columns.map((column) => stored(dialect, column, row[column as keyof Sample]))
      await connection.run(
        sql`INSERT INTO ${sql.id('samples')} (${sql.join(
          [sql.id('id'), ...columns.map((c) => sql.id(c))],
          ', ',
        )}) VALUES (${sql.join([sql`${id}`, ...values.map((v) => sql`${v}`)], ', ')})`,
      )
      records.push(canonical(row, id))
    }
  })
  afterAll(async () => {
    if (skipped !== undefined) return
    await connection.close()
    await server?.drop()
  })

  it.skipIf(skipped !== undefined)(
    `agrees on every generated filter${skipped === undefined ? '' : ` (skipped: ${skipped})`}`,
    async () => {
      await fc.assert(
        fc.asyncProperty(filterArb, actorArb, async (filter, actor) => {
          const bound = bindFilter(filter, { fields, operators: 'any', actor })
          const where = compileFilterSql(bound, connection.grammar, 's')
          const { rows } = await connection.run(
            sql`SELECT ${sql.id('s')}.${sql.id('id')} AS ${sql.id('id')} FROM ${sql.id('samples')} ${sql.id('s')} WHERE ${where}`,
          )
          const actual = rows.map((row) => Number(row['id'])).sort((a, b) => a - b)
          const expected = records
            .filter((record) => evaluateFilter(bound, record))
            .map((record) => Number(record['id']))
            .sort((a, b) => a - b)
          expect(actual).toEqual(expected)
        }),
        { numRuns: 250, seed: 11 },
      )
    },
  )
})
