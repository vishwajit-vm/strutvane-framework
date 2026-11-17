/**
 * What the parent accepts back from the replay sandbox's child (`replayRecorded`): plain JSON,
 * re-checked as strictly as the schema builder itself would have produced it. Each case starts
 * from genuine recorded operations and tampers with them the way a child that escaped the
 * builder could, then expects a refusal: tenancy rewrites skipped (F-05/F-14), sizes that would
 * make DDL generation allocate without bound, and operation lists long enough to stall the parent.
 */
import { describe, expect, test } from 'vitest'
import { EMPTY_SCHEMA } from '../../../src/schema/columns.ts'
import { SchemaError } from '../../../src/schema/errors.ts'
import { recordOperations, type SchemaBuilder } from '../../../src/schema/migration.ts'
import type { SchemaOperation } from '../../../src/schema/operations.ts'
import { replayRecorded } from '../../../src/schema/replay.ts'

/** Genuine operations: two tenant tables, a composite key between them, a per-tenant unique. */
function tenantOperations(): SchemaOperation[] {
  return recordOperations((schema) => {
    schema.create('projects', (t) => {
      t.id()
      t.tenant()
      t.string('code', 40).unique()
    })
    schema.create('tasks', (t) => {
      t.id()
      t.tenant()
      t.foreignId('project_id').constrained('projects').cascadeOnDelete()
    })
  }, EMPTY_SCHEMA)
}

/** A deep, freely editable copy (the shape a child would send). */
type Json = Record<string, unknown> & { actions: Record<string, unknown>[] }
const tampered = (edit: (ops: Json[]) => void): unknown => {
  const ops = JSON.parse(JSON.stringify(tenantOperations())) as Json[]
  edit(ops)
  return ops
}

function refusal(up: unknown): SchemaError {
  try {
    replayRecorded([{ name: '2026_01_01_000000_tenants', up, down: [] }])
  } catch (error) {
    if (error instanceof SchemaError) return error
    throw error
  }
  throw new Error('expected the recorded operations to be refused')
}

const isAddIndex = (action: Record<string, unknown>): boolean => action['type'] === 'addIndex'
const indexOf = (action: Record<string, unknown>): { columns: string[]; name: string } =>
  action['index'] as { columns: string[]; name: string }

describe('tenancy rewrites are required, not trusted', () => {
  test('the genuine operations are accepted', () => {
    const replay = replayRecorded([{ name: 'x', up: tampered(() => {}), down: [] }])
    expect(replay.state.tables.map((table) => table.name)).toEqual(['projects', 'tasks'])
  })

  test('a unique index without the tenant column (a cross-tenant uniqueness oracle)', () => {
    const up = tampered((ops) => {
      for (const action of ops[0]?.actions ?? []) {
        const index = isAddIndex(action) ? indexOf(action) : undefined
        if (index?.name.includes('code')) index.columns = ['code']
      }
    })
    expect(refusal(up).code).toBe('invalid_tenancy')
  })

  test('a plain foreign key between tenant tables (a cross-tenant reference)', () => {
    const up = tampered((ops) => {
      for (const action of ops[1]?.actions ?? []) {
        const column = action['column'] as { references?: Record<string, unknown> } | undefined
        if (column?.references !== undefined) delete column.references['tenant']
      }
    })
    expect(refusal(up).code).toBe('invalid_tenancy')
  })

  test('a tenant table without its (tenant, id) key', () => {
    const up = tampered((ops) => {
      const tasks = ops[1]
      if (tasks !== undefined)
        tasks.actions = tasks.actions.filter(
          (action) => !(isAddIndex(action) && indexOf(action).columns.join() === 'tenant_id,id'),
        )
    })
    expect(refusal(up).code).toBe('invalid_tenancy')
  })
})

describe('sizes and counts are bounded', () => {
  const withColumn = (column: Record<string, unknown>): unknown => [
    {
      type: 'createTable',
      table: 'prices',
      actions: [
        { type: 'addColumn', column: { name: 'id', kind: 'id', nullable: false } },
        { type: 'addColumn', column: { name: 'amount', nullable: false, ...column } },
      ],
    },
  ]

  test.each([
    ['a negative scale', { kind: 'decimal', precision: 5, scale: -7 }],
    ['a scale above the precision', { kind: 'decimal', precision: 5, scale: 6 }],
    ['a precision of 500 million', { kind: 'decimal', precision: 500_000_000, scale: 2 }],
    ['a zero precision', { kind: 'decimal', precision: 0, scale: 0 }],
    ['a length of 0', { kind: 'string', length: 0 }],
    ['a length beyond 65,535', { kind: 'string', length: 1_000_000 }],
    ['a fractional length', { kind: 'string', length: 1.5 }],
  ])('refuses %s', (_what, column) => {
    expect(refusal(withColumn(column)).code).toBe('invalid_migration')
  })

  test('accepts the largest portable sizes', () => {
    const decimal = withColumn({ kind: 'decimal', precision: 65, scale: 65 })
    expect(() => replayRecorded([{ name: 'x', up: decimal, down: [] }])).not.toThrow()
  })

  test('refuses more than 1,000 operations, or 1,000 actions in one operation', () => {
    const drops = Array.from({ length: 1_001 }, () => ({
      type: 'dropTable',
      table: 'x',
      ifExists: true,
    }))
    expect(refusal(drops).message).toMatch(/more than 1000/)
    const indexes = Array.from({ length: 1_001 }, (_, i) => ({
      type: 'addIndex',
      index: { name: `i${i}`, columns: ['id'], unique: false },
    }))
    expect(refusal([{ type: 'alterTable', table: 'x', actions: indexes }]).message).toMatch(
      /more than 1000/,
    )
  })

  test('the schema builder enforces the same limits', () => {
    for (const define of [
      (schema: SchemaBuilder) => schema.create('p', (t) => void t.decimal('a', 66, 2)),
      (schema: SchemaBuilder) => schema.create('p', (t) => void t.string('a', 65_536)),
    ])
      expect(() => recordOperations(define, EMPTY_SCHEMA)).toThrow(SchemaError)
  })
})

describe('the recorder', () => {
  test('a migration cannot push operations past the builder, now or later', () => {
    let held: unknown
    const operations = recordOperations((schema) => {
      held = schema
      const raw = Reflect.get(schema, 'operations')
      if (Array.isArray(raw)) raw.push({ type: 'dropTable', table: 'users', ifExists: false })
      schema.create('tags', (t) => {
        t.id()
        t.enum('kind', ['a', 'b'])
      })
    }, EMPTY_SCHEMA)
    expect(Reflect.get(held as object, 'operations')).toBeUndefined()
    expect(operations.map((op) => op.type)).toEqual(['createTable'])
    // What was returned is a copy: the recorder's own list can't be reached through it.
    operations.push({ type: 'dropTable', table: 'tags', ifExists: false })
    expect(Reflect.apply(Reflect.get(held as object, 'recorded'), held, [])).toHaveLength(1)
  })
})
