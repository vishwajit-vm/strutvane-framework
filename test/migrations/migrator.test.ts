import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../../src/database/types.ts'
import {
  answersResolver,
  checksumOf,
  migrationFileName,
  migrationSource,
  parseMigration,
  readMigrations,
  readSnapshot,
  renderMigration,
  sanitizeMigrationName,
  writeMigration,
} from '../../src/migrations/files.ts'
import {
  detectSchemaDrift,
  MIGRATIONS_TABLE,
  MigrationDriftError,
  migrate,
  migrationStatus,
} from '../../src/migrations/migrator.ts'
import { planMigration } from '../../src/migrations/planner.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { createDatabase, DIALECTS, tables } from '../helpers/engines.ts'
import { Customer, Invoice, models } from '../helpers/models.ts'

let db: Database | undefined
let dir: string | undefined
afterEach(async () => {
  await db?.close()
  db = undefined
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const at = new Date('2026-11-14T12:00:00.000Z')

describe('migration files', () => {
  it('names files with a sortable UTC timestamp and a sanitised name', () => {
    expect(migrationFileName('Create invoices!', at)).toBe('20261114120000_create_invoices')
    expect(sanitizeMigrationName('  ../../etc/passwd ')).toBe('etc_passwd')
    expect(() => sanitizeMigrationName('!!!')).toThrow(/at least one letter/)
  })

  it('renders a header recording renames, separations and destructive changes, and parses it back', async () => {
    const renamed = defineModel(
      'Invoice',
      { ...withoutKeys(Invoice.fields, 'notes', 'issuedOn'), memo: field.text().optional() },
      { tenant: true, softDeletes: true },
    )
    const plan = await planMigration({
      dialect: 'postgres',
      previous: models,
      next: [Customer.definition, renamed.definition],
      resolveRename: (c) =>
        c.kind === 'column' && c.fromColumn === 'notes' ? 'rename' : 'separate',
      allowDestructive: true,
    })
    const text = renderMigration(plan, { name: 'rename notes', createdAt: at })
    expect(text).toContain('-- rename: column invoices.notes -> memo')
    expect(text).toContain('-- destructive: [data-loss] dropColumn invoices.issued_on')
    const parsed = parseMigration(text.replaceAll('\n', '\r\n'))
    expect(parsed.header).toMatchObject({
      name: 'rename_notes',
      dialect: 'postgres',
      created: at.toISOString(),
    })
    expect(parsed.header.renames).toEqual(['column invoices.notes -> memo'])
    expect(parsed.header.destructive).toHaveLength(1)
    expect(parsed.statements).toEqual(plan.statements)
  })

  it('replays recorded answers and rejects unknown candidates', async () => {
    const resolve = answersResolver({ 'column invoices.notes -> memo': 'rename' })
    expect(
      await resolve({
        kind: 'column',
        model: 'Invoice',
        table: 'invoices',
        fromField: 'notes',
        toField: 'memo',
        fromColumn: 'notes',
        toColumn: 'memo',
      }),
    ).toBe('rename')
    expect(() =>
      resolve({ kind: 'table', fromModel: 'A', toModel: 'B', fromTable: 'as', toTable: 'bs' }),
    ).toThrow(/No recorded answer/)
  })

  it('checksums ignore line endings but not content', () => {
    expect(checksumOf(['a\r\nb'])).toBe(checksumOf(['a\nb']))
    expect(checksumOf(['a'])).not.toBe(checksumOf(['b']))
  })

  it('writes the migration and snapshot, reads them back, and writes nothing for empty plans', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sv-mig-'))
    const target = join(dir, 'migrations')
    expect((await readSnapshot(target, 'sqlite')).models).toEqual([])
    expect(await readMigrations(target)).toEqual([])
    const plan = await planMigration({ dialect: 'sqlite', previous: [], next: models })
    const name = await writeMigration(target, plan, models, { name: 'init', createdAt: at })
    expect(name).toBe('20261114120000_init')
    await expect(
      writeMigration(target, plan, models, { name: 'init', createdAt: at }),
    ).rejects.toThrow(/already exists/)
    const snapshot = await readSnapshot(target, 'sqlite')
    expect(snapshot.models.map((m) => m.name)).toEqual(['Customer', 'Invoice'])
    await expect(readSnapshot(target, 'postgres')).rejects.toThrow(/is for sqlite/)
    const loaded = await readMigrations(target)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.statements).toEqual(plan.statements)
    const empty = await planMigration({ dialect: 'sqlite', previous: models, next: models })
    expect(await writeMigration(target, empty, models, { name: 'noop' })).toBeUndefined()
    await writeFile(join(target, 'snapshot.json'), '{"version":2}')
    await expect(readSnapshot(target, 'sqlite')).rejects.toThrow(/Unsupported snapshot/)
  })
})

describe.each(DIALECTS)('migrator on %s', (dialect) => {
  it('applies pending migrations once, in order, in one batch, and reports status', async () => {
    db = await createDatabase(dialect)
    const plan = await planMigration({ dialect, previous: [], next: models })
    const first = migrationSource('20261114120000_init', plan.statements)
    expect((await migrationStatus(db, [first])).pending).toEqual(['20261114120000_init'])
    expect(await migrate(db, [first], { now: () => at })).toEqual(['20261114120000_init'])
    expect(await migrate(db, [first])).toEqual([])
    expect(await tables(db)).toEqual(
      expect.arrayContaining(['customers', 'invoices', MIGRATIONS_TABLE]),
    )

    const Next = defineModel(
      'Customer',
      { ...Customer.fields, phone: field.string(20).optional() },
      { tenant: true },
    )
    const next = [Next.definition, Invoice.definition]
    const plan2 = await planMigration({ dialect, previous: models, next })
    const second = migrationSource('20261115120000_phone', plan2.statements)
    expect(await migrate(db, [first, second])).toEqual(['20261115120000_phone'])
    const status = await migrationStatus(db, [first, second])
    expect(status.pending).toEqual([])
    expect(status.drift).toEqual([])
    expect(status.applied.map((a) => [a.name, a.batch])).toEqual([
      ['20261114120000_init', 1],
      ['20261115120000_phone', 2],
    ])
    expect(status.applied[0]?.appliedAt).toBe(at.toISOString())
    expect(await detectSchemaDrift(db, next)).toEqual([])
  })

  it('rolls back the whole batch when a statement fails', async () => {
    db = await createDatabase(dialect)
    const good = migrationSource('001_good', ['CREATE TABLE "a" ("id" TEXT PRIMARY KEY)'])
    const bad = migrationSource('002_bad', [
      'CREATE TABLE "b" ("id" TEXT PRIMARY KEY)',
      'THIS IS NOT SQL',
    ])
    await expect(migrate(db, [good, bad])).rejects.toThrow()
    expect(await tables(db)).not.toContain('a')
    expect((await migrationStatus(db, [good, bad])).pending).toEqual(['001_good', '002_bad'])
  })

  it('refuses to run when an applied migration changed or vanished', async () => {
    db = await createDatabase(dialect)
    const one = migrationSource('001_one', ['CREATE TABLE "a" ("id" TEXT PRIMARY KEY)'])
    await migrate(db, [one])
    const edited = migrationSource('001_one', [
      'CREATE TABLE "a" ("id" TEXT PRIMARY KEY, "x" TEXT)',
    ])
    const err = await migrate(db, [edited]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationDriftError)
    expect((err as MigrationDriftError).drift).toEqual([{ name: '001_one', kind: 'changed' }])
    expect((await migrationStatus(db, [])).drift).toEqual([{ name: '001_one', kind: 'missing' }])
  })

  it('rejects unsorted or duplicate migration lists', async () => {
    db = await createDatabase(dialect)
    const a = migrationSource('002', ['SELECT 1'])
    const b = migrationSource('001', ['SELECT 1'])
    await expect(migrationStatus(db, [a, b])).rejects.toThrow(/sorted/)
  })

  it('detects schema drift: missing tables, missing and extra columns', async () => {
    db = await createDatabase(dialect)
    await db.execute('CREATE TABLE "customers" ("id" TEXT PRIMARY KEY, "rogue" TEXT)')
    const drift = await detectSchemaDrift(db, models)
    expect(drift).toEqual(
      expect.arrayContaining([
        { table: 'invoices', kind: 'missingTable' },
        { table: 'customers', column: 'name', kind: 'missingColumn' },
        { table: 'customers', column: 'rogue', kind: 'extraColumn' },
      ]),
    )
  })

  it('applies files written to disk end to end', async () => {
    db = await createDatabase(dialect)
    dir = await mkdtemp(join(tmpdir(), 'sv-mig-'))
    const plan = await planMigration({ dialect, previous: [], next: models })
    await writeMigration(dir, plan, models, { name: 'init', createdAt: at })
    const text = await readFile(join(dir, '20261114120000_init.sql'), 'utf8')
    expect(text.startsWith('-- strutvane:migration')).toBe(true)
    expect(await migrate(db, await readMigrations(dir))).toEqual(['20261114120000_init'])
  })
})

describe('migrator on postgres: concurrency', () => {
  it('serialises concurrent runs under the advisory lock: each migration applies once', async () => {
    db = await createDatabase('postgres')
    const one = migrationSource('001_one', ['CREATE TABLE "a" ("id" TEXT PRIMARY KEY)'])
    const results = await Promise.all([migrate(db, [one]), migrate(db, [one])])
    expect(results.flat()).toEqual(['001_one'])
  })
})

function withoutKeys<T extends Record<string, unknown>>(obj: T, ...keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k))) as Partial<T>
}
