import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../../src/database/types.ts'
import {
  assertPromptFree,
  DestructiveChangeError,
  planMigration,
  type RenameCandidate,
  RenameResolutionRequiredError,
} from '../../src/migrations/planner.ts'
import { type AnyModel, defineModel, type FieldMap } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { defaultNaming, shortenIdentifier } from '../../src/schema/compile.ts'
import { columns, createDatabase, DIALECTS, indexes, ph, tables } from '../helpers/engines.ts'
import { Customer, Invoice, models } from '../helpers/models.ts'

const TENANT = '0190a000-0000-7000-8000-000000000001'

let db: Database | undefined
afterEach(async () => {
  await db?.close()
  db = undefined
})

async function apply(target: Database, statements: readonly string[]): Promise<void> {
  for (const s of statements) {
    if (/^PRAGMA\s+foreign_keys/i.test(s)) continue
    await target.execute(s)
  }
}

describe.each(DIALECTS)('planner on %s', (dialect) => {
  it('creates tables with typed columns, constraints and indexes', async () => {
    db = await createDatabase(dialect)
    const plan = await planMigration({ dialect, previous: [], next: models })
    await apply(db, plan.statements)
    expect(await tables(db)).toEqual(['customers', 'invoices'])
    const cols = await columns(db, 'invoices')
    expect(Object.keys(cols).sort()).toEqual(
      [
        'amount',
        'created_at',
        'customer_id',
        'deleted_at',
        'id',
        'issued_on',
        'notes',
        'number',
        'status',
        'tenant_id',
        'updated_at',
      ].sort(),
    )
    expect(cols['amount']?.type).toBe(dialect === 'postgres' ? 'numeric(12,2)' : 'text')
    expect(cols['notes']?.nullable).toBe(true)
    expect(cols['number']?.nullable).toBe(false)
    expect(await indexes(db, 'invoices')).toEqual(
      expect.arrayContaining([
        'invoices_number_unique',
        'invoices_customer_id_idx',
        'invoices_tenant_id_idx',
        'invoices_deleted_at_idx',
      ]),
    )
  })

  it('enforces the enum CHECK, per-tenant unique and the foreign key', async () => {
    db = await createDatabase(dialect)
    const plan = await planMigration({ dialect, previous: [], next: models })
    await apply(db, plan.statements)
    const now = new Date().toISOString()
    const cust = '0190a000-0000-7000-8000-0000000000c1'
    const p = (n: number): string => ph(db as Database, n)
    const insertCustomer = `insert into customers (id, tenant_id, name, email, created_at, updated_at) values (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`
    if (dialect === 'postgres')
      await db.execute(`select set_config('app.tenant_id', $1, false)`, [TENANT])
    await db.execute(insertCustomer, [cust, TENANT, 'Acme', 'a@acme.test', now, now])
    const insertInvoice = `insert into invoices (id, tenant_id, number, amount, status, customer_id, created_at, updated_at) values (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)})`
    await db.execute(insertInvoice, [
      '0190a000-0000-7000-8000-0000000000a1',
      TENANT,
      'INV-1',
      '10.50',
      'draft',
      cust,
      now,
      now,
    ])
    // enum CHECK
    await expect(
      db.execute(insertInvoice, [
        '0190a000-0000-7000-8000-0000000000a2',
        TENANT,
        'INV-2',
        '1',
        'bogus',
        cust,
        now,
        now,
      ]),
    ).rejects.toThrow()
    // unique per tenant
    await expect(
      db.execute(insertInvoice, [
        '0190a000-0000-7000-8000-0000000000a3',
        TENANT,
        'INV-1',
        '1',
        'draft',
        cust,
        now,
        now,
      ]),
    ).rejects.toThrow()
    // foreign key
    await expect(
      db.execute(insertInvoice, [
        '0190a000-0000-7000-8000-0000000000a4',
        TENANT,
        'INV-4',
        '1',
        'draft',
        '0190a000-0000-7000-8000-0000000000ff',
        now,
        now,
      ]),
    ).rejects.toThrow()
  })

  it('is idempotent: planning the same models again yields zero statements', async () => {
    const plan = await planMigration({ dialect, previous: models, next: models })
    expect(plan.statements).toEqual([])
  })

  it('adds an optional column without touching rows', async () => {
    db = await createDatabase(dialect)
    await apply(db, (await planMigration({ dialect, previous: [], next: models })).statements)
    const next = defineModel(
      'Customer',
      { ...fieldsOf(Customer), phone: field.string(30).optional() },
      { tenant: true },
    )
    const plan = await planMigration({
      dialect,
      previous: models,
      next: [next.definition, Invoice.definition],
    })
    expect(plan.destructive).toEqual([])
    await apply(db, plan.statements)
    expect(Object.keys(await columns(db, 'customers'))).toContain('phone')
  })

  it('refuses to guess about a possible rename without a resolver', async () => {
    const renamed = defineModel(
      'Invoice',
      { ...fieldsOf(Invoice, 'notes'), memo: field.text().optional() },
      { tenant: true, softDeletes: true },
    )
    const err = await planMigration({
      dialect,
      previous: models,
      next: [Customer.definition, renamed.definition],
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RenameResolutionRequiredError)
    expect((err as RenameResolutionRequiredError).candidates).toEqual([
      expect.objectContaining({ kind: 'column', fromColumn: 'notes', toColumn: 'memo' }),
    ])
  })

  it('renames a column keeping its data when the resolver says rename', async () => {
    db = await createDatabase(dialect)
    await apply(db, (await planMigration({ dialect, previous: [], next: models })).statements)
    const renamed = defineModel(
      'Invoice',
      { ...fieldsOf(Invoice, 'notes'), memo: field.text().optional() },
      { tenant: true, softDeletes: true },
    )
    const next = [Customer.definition, renamed.definition]
    const asked: RenameCandidate[] = []
    const plan = await planMigration({
      dialect,
      previous: models,
      next,
      resolveRename: (c) => {
        asked.push(c)
        return 'rename'
      },
    })
    expect(asked).toHaveLength(1)
    expect(plan.statements[0]).toBe('ALTER TABLE "invoices" RENAME COLUMN "notes" TO "memo";')
    await apply(db, plan.statements)
    expect(Object.keys(await columns(db, 'invoices'))).toContain('memo')
    expect((await planMigration({ dialect, previous: next, next })).statements).toEqual([])
  })

  it('treats "separate" as drop + create, which is destructive and blocked by default', async () => {
    const renamed = defineModel(
      'Invoice',
      { ...fieldsOf(Invoice, 'notes'), memo: field.text().optional() },
      { tenant: true, softDeletes: true },
    )
    const next = [Customer.definition, renamed.definition]
    await expect(
      planMigration({ dialect, previous: models, next, resolveRename: () => 'separate' }),
    ).rejects.toBeInstanceOf(DestructiveChangeError)
    const plan = await planMigration({
      dialect,
      previous: models,
      next,
      resolveRename: () => 'separate',
      allowDestructive: true,
    })
    expect(plan.separated).toHaveLength(1)
    expect(plan.destructive).toEqual([
      expect.objectContaining({ kind: 'dropColumn', column: 'notes' }),
    ])
  })

  it('renames a table (model rename) and keeps data, foreign keys and re-derived index names', async () => {
    db = await createDatabase(dialect)
    await apply(db, (await planMigration({ dialect, previous: [], next: models })).statements)
    const Client = defineModel('Client', fieldsOf(Customer, 'invoices'), { tenant: true })
    const Inv = defineModel(
      'Invoice',
      { ...fieldsOf(Invoice, 'customer'), customer: field.belongsTo('Client') },
      { tenant: true, softDeletes: true },
    )
    const plan = await planMigration({
      dialect,
      previous: models,
      next: [Client.definition, Inv.definition],
      resolveRename: (c) => (c.kind === 'table' ? 'rename' : 'separate'),
    })
    expect(plan.renames).toEqual([
      expect.objectContaining({ kind: 'table', fromTable: 'customers', toTable: 'clients' }),
    ])
    await apply(db, plan.statements)
    expect(await tables(db)).toEqual(['clients', 'invoices'])
    expect(await indexes(db, 'clients')).toEqual(
      expect.arrayContaining(['clients_email_unique', 'clients_tenant_id_idx']),
    )
  })

  it('blocks dropping a column unless allowDestructive, then applies it', async () => {
    db = await createDatabase(dialect)
    await apply(db, (await planMigration({ dialect, previous: [], next: models })).statements)
    const next = defineModel('Invoice', fieldsOf(Invoice, 'notes'), {
      tenant: true,
      softDeletes: true,
    })
    const input = { dialect, previous: models, next: [Customer.definition, next.definition] }
    await expect(planMigration(input)).rejects.toBeInstanceOf(DestructiveChangeError)
    const plan = await planMigration({ ...input, allowDestructive: true })
    await apply(db, plan.statements)
    expect(Object.keys(await columns(db, 'invoices'))).not.toContain('notes')
  })

  it('drops a referenced model together with the belongsTo pointing at it', async () => {
    db = await createDatabase(dialect)
    await apply(db, (await planMigration({ dialect, previous: [], next: models })).statements)
    const Inv = defineModel('Invoice', fieldsOf(Invoice, 'customer'), {
      tenant: true,
      softDeletes: true,
    })
    const plan = await planMigration({
      dialect,
      previous: models,
      next: [Inv.definition],
      allowDestructive: true,
    })
    expect(plan.destructive.map((d) => d.kind).sort()).toEqual(['dropColumn', 'dropTable'])
    await apply(db, plan.statements)
    expect(await tables(db)).toEqual(['invoices'])
  })

  it('applies type changes, narrowing and enum changes on a table with data', async () => {
    db = await createDatabase(dialect)
    const A = defineModel('Thing', {
      name: field.string(100),
      size: field.integer().optional(),
      kind: field.enum(['a', 'b', 'c']),
    })
    await apply(
      db,
      (await planMigration({ dialect, previous: [], next: [A.definition] })).statements,
    )
    const now = new Date().toISOString()
    const p = (n: number): string => ph(db as Database, n)
    await db.execute(
      `insert into things (id, name, size, kind, created_at, updated_at) values (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
      ['0190a000-0000-7000-8000-000000000011', 'x', 1, 'a', now, now],
    )
    const B = defineModel('Thing', {
      name: field.string(50),
      size: field.integer(),
      kind: field.enum(['a', 'b']),
    })
    const err = (await planMigration({
      dialect,
      previous: [A.definition],
      next: [B.definition],
    }).catch((e: unknown) => e)) as DestructiveChangeError
    expect(err.changes.map((c) => c.kind).sort()).toEqual([
      'makeRequired',
      'narrowType',
      'removeEnumValues',
    ])
    const plan = await planMigration({
      dialect,
      previous: [A.definition],
      next: [B.definition],
      allowDestructive: true,
    })
    await apply(db, plan.statements)
    const rows = await db.query<{ name: string }>('select name from things')
    expect(rows).toEqual([{ name: 'x' }])
    await expect(
      db.execute(
        `insert into things (id, name, size, kind, created_at, updated_at) values (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
        ['0190a000-0000-7000-8000-000000000012', 'y', 1, 'c', now, now],
      ),
    ).rejects.toThrow()
  })

  it('classifies changing a kind, adding required/unique columns and toggling options', async () => {
    const A = defineModel('Thing', { name: field.string(), qty: field.integer() })
    const B = defineModel(
      'Thing',
      { name: field.text(), qty: field.integer(), code: field.string().unique() },
      { timestamps: false, softDeletes: true, tenant: true },
    )
    const err = (await planMigration({
      dialect,
      previous: [A.definition],
      next: [B.definition],
    }).catch((e: unknown) => e)) as DestructiveChangeError
    const kinds = err.changes.map((c) => `${c.kind}:${c.column ?? ''}`).sort()
    expect(kinds).toEqual(
      [
        'addRequiredWithoutDefault:code',
        'addRequiredWithoutDefault:tenant_id',
        'addUnique:code',
        'changeType:name',
        'dropColumn:created_at',
        'dropColumn:updated_at',
      ].sort(),
    )
    expect(err.message).toContain('allowDestructive')
  })

  it('passes recorded decisions through the resolver and validates them', async () => {
    const renamed = defineModel(
      'Invoice',
      { ...fieldsOf(Invoice, 'notes'), memo: field.text().optional() },
      { tenant: true, softDeletes: true },
    )
    await expect(
      planMigration({
        dialect,
        previous: models,
        next: [Customer.definition, renamed.definition],
        resolveRename: () => 'maybe' as 'rename',
      }),
    ).rejects.toThrow(/must return 'rename' or 'separate'/)
  })
})

describe('tenancy statements', () => {
  it('enables RLS for new tenant tables on Postgres and removes it when tenancy is turned off', async () => {
    const created = await planMigration({ dialect: 'postgres', previous: [], next: models })
    expect(created.statements).toEqual(
      expect.arrayContaining([
        'ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;',
        expect.stringContaining('CREATE POLICY "tenant_isolation" ON "invoices" AS RESTRICTIVE'),
      ]),
    )
    const Plain = defineModel('Customer', fieldsOf(Customer, 'invoices'))
    const off = await planMigration({
      dialect: 'postgres',
      previous: [Customer.definition],
      next: [Plain.definition],
      allowDestructive: true,
    })
    expect(off.statements).toEqual(
      expect.arrayContaining(['ALTER TABLE "customers" DISABLE ROW LEVEL SECURITY;']),
    )
    const lite = await planMigration({ dialect: 'sqlite', previous: [], next: models })
    expect(lite.statements.join('\n')).not.toContain('POLICY')
  })
})

describe('assertPromptFree', () => {
  const a = defineModel('Alpha', { name: field.string() }).definition
  const b = defineModel('Beta', { name: field.string() }).definition
  it('rejects a diff that both creates and deletes tables', () => {
    expect(() => assertPromptFree([a], [b])).toThrow(/creates \[betas\] and deletes \[alphas\]/)
  })
  it('rejects a diff that both adds and drops columns of a table', () => {
    const a2 = defineModel('Alpha', { title: field.string() }).definition
    expect(() => assertPromptFree([a], [a2])).toThrow(/both adds \[title\] and drops \[name\]/)
  })
  it('accepts pure additions and pure removals', () => {
    expect(() => assertPromptFree([a], [a, b])).not.toThrow()
    expect(() => assertPromptFree([a, b], [a])).not.toThrow()
  })
})

/** The field builders of a model, minus some keys, so tests can derive variants. */
function fieldsOf(model: AnyModel, ...omit: string[]): FieldMap {
  return Object.fromEntries(
    Object.entries(model.fields as FieldMap).filter(([k]) => !omit.includes(k)),
  )
}

describe('identifier naming', () => {
  it('shortens names over 63 bytes deterministically and applies them on Postgres', async () => {
    const long = `${'very_long_column_name_'.repeat(3)}x`
    const name = defaultNaming('unique', 'a_table_with_a_long_name', long)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63)
    expect(name).toBe(defaultNaming('unique', 'a_table_with_a_long_name', long))
    expect(shortenIdentifier('short')).toBe('short')
    const Wide = defineModel('Wide', { [lowerCamel(long)]: field.string().unique() } as FieldMap, {
      table: 'a_table_with_a_long_name',
    })
    const db = await createDatabase('postgres')
    try {
      await apply(
        db,
        (await planMigration({ dialect: 'postgres', previous: [], next: [Wide.definition] }))
          .statements,
      )
      expect(await indexes(db, 'a_table_with_a_long_name')).toContain(name)
    } finally {
      await db.close()
    }
  })
})

function lowerCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}
