/**
 * The fold re-checks everything, even operations that didn't come from the recorder (the replay
 * sandbox hands operations over as data), plus the builder methods the fixtures don't use.
 */
import { describe, expect, test } from 'vitest'
import { applyOperations } from '../../src/schema/apply.ts'
import {
  type ColumnDef,
  EMPTY_SCHEMA,
  findColumn,
  findTable,
  type SchemaState,
} from '../../src/schema/columns.ts'
import { SchemaError } from '../../src/schema/errors.ts'
import { recordOperations } from '../../src/schema/migration.ts'
import type { SchemaOperation, TableAction } from '../../src/schema/operations.ts'

const id: ColumnDef = { name: 'id', kind: 'id', nullable: false }
const tenant: ColumnDef = { name: 'tenant_id', kind: 'uuid', nullable: false, tenant: true }

function code(ops: readonly SchemaOperation[], from: SchemaState = EMPTY_SCHEMA): string {
  try {
    applyOperations(from, ops)
  } catch (error) {
    if (error instanceof SchemaError) return error.code
    throw error
  }
  return 'ok'
}

const create = (
  table: string,
  actions: readonly TableAction[],
  global = false,
): SchemaOperation => ({
  type: 'createTable',
  table,
  actions,
  ...(global ? { options: { global: true } } : {}),
})
const add = (column: ColumnDef): TableAction => ({ type: 'addColumn', column })

describe('operations that bypass the recorder are still checked', () => {
  test('unknown operations and actions fail closed', () => {
    expect(code([{ type: 'truncate', table: 'x' } as never])).toBe('INVALID_MIGRATION')
    expect(
      code([
        create('x', [add(id)]),
        { type: 'alterTable', table: 'x', actions: [{ type: 'raw' } as never] },
      ]),
    ).toBe('INVALID_MIGRATION')
  })

  test('two tenant columns, or a tenant column on a global table', () => {
    expect(code([create('x', [add(tenant), add({ ...tenant, name: 'team_id' })])])).toBe(
      'INVALID_TENANCY',
    )
    expect(code([create('x', [add(id), add(tenant)], true)])).toBe('INVALID_TENANCY')
  })

  test('a composite key needs both tenant columns and the parent (tenant, id) key', () => {
    const parent = create('projects', [add(id), add(tenant)])
    const key = (child: readonly ColumnDef[], parentColumn = 'tenant_id'): SchemaOperation =>
      create('tasks', [
        ...child.map(add),
        add({
          name: 'project_id',
          kind: 'foreignId',
          nullable: false,
          references: {
            table: 'projects',
            column: 'id',
            onDelete: 'cascade',
            tenant: { column: 'tenant_id', parentColumn },
          },
        }),
      ])
    // No unique (tenant_id, id) on the parent: the database would refuse the key.
    expect(code([parent, key([id, tenant])])).toBe('INVALID_TENANCY')
    // The child has no tenant column.
    expect(code([parent, key([id])])).toBe('INVALID_TENANCY')
    // The parent's tenant column is named differently.
    expect(code([parent, key([id, tenant], 'team_id')])).toBe('INVALID_TENANCY')
  })
})

describe('builder methods', () => {
  test('numbers, timestamps, restrict and the drop helpers', () => {
    const state = applyOperations(
      EMPTY_SCHEMA,
      recordOperations((schema) => {
        schema.create('accounts', (t) => {
          t.id()
          t.bigInteger('balance')
          t.double('ratio')
          t.timestamp('closed_at').nullable()
          t.string('code').unique()
          t.timestamps()
          t.softDeletes()
        })
        schema.create('entries', (t) => {
          t.id()
          t.foreignId('account_id').constrained().restrictOnDelete()
        })
      }, EMPTY_SCHEMA),
    )
    const accounts = findTable(state, 'accounts')
    expect(accounts && findColumn(accounts, 'balance')?.kind).toBe('bigInteger')
    expect(accounts && findColumn(accounts, 'ratio')?.kind).toBe('double')
    const entries = findTable(state, 'entries')
    expect(entries && findColumn(entries, 'account_id')?.references?.onDelete).toBe('restrict')
    const after = applyOperations(
      state,
      recordOperations((schema) => {
        schema.table('accounts', (t) => {
          t.dropTimestamps()
          t.dropSoftDeletes()
          t.dropUnique('accounts_code_unique')
        })
      }, state),
    )
    expect(findTable(after, 'accounts')?.columns.map((column) => column.name)).toEqual([
      'id',
      'balance',
      'ratio',
      'closed_at',
      'code',
    ])
    expect(findTable(after, 'accounts')?.indexes).toEqual([])
  })
})
