/**
 * Fold recorded operations into a {@link SchemaState}: the in-memory "database" of the recorder.
 *
 * This is where migration mistakes are caught *before* any SQL runs: renaming a column that
 * doesn't exist, pointing a foreign key at a missing table, dropping a column a slug is built
 * from, and so on. Every check fails closed with a friendly {@link SchemaError}.
 *
 * Where SQLite and PostgreSQL disagree, the stricter rule wins, so a migration that replays
 * cleanly here runs on both engines. For example, adding a `NOT NULL` column without a default to
 * an existing table works on an empty PostgreSQL table but always fails on SQLite, so it's
 * refused here.
 *
 * @module
 */
import {
  type ColumnDef,
  findColumn,
  findTable,
  type IndexDef,
  type SchemaState,
  type TableState,
  tenantColumnOf,
} from './columns.ts'
import { SchemaError } from './errors.ts'
import type { CreateTableOptions, SchemaOperation, TableAction } from './operations.ts'

/**
 * Apply one operation and return the new state. The input state is never mutated, so callers can
 * keep every intermediate state (the rollback tests rely on that).
 *
 * @example
 * const next = applyOperation(EMPTY_SCHEMA, { type: 'createTable', table: 'tags', actions: [] })
 */
export function applyOperation(state: SchemaState, operation: SchemaOperation): SchemaState {
  switch (operation.type) {
    case 'createTable':
      return createTable(state, operation.table, operation.actions, operation.options)
    case 'alterTable':
      return alterTable(state, operation.table, operation.actions)
    case 'dropTable':
      return dropTable(state, operation.table, operation.ifExists)
    case 'renameTable':
      return renameTable(state, operation.from, operation.to)
    default:
      return unknownStep(operation)
  }
}

/** Fail closed on anything that isn't a known operation (input from outside the recorder). */
function unknownStep(step: never): never {
  throw new SchemaError(
    'invalid_migration',
    `Unknown schema step ${JSON.stringify((step as { type?: unknown }).type)}.`,
    'Only operations made by the schema builder can be applied.',
  )
}

/**
 * Apply a list of operations in order.
 *
 * @example
 * const state = applyOperations(EMPTY_SCHEMA, recordOperations(m.up, EMPTY_SCHEMA))
 */
export function applyOperations(
  state: SchemaState,
  operations: readonly SchemaOperation[],
): SchemaState {
  return operations.reduce(applyOperation, state)
}

function createTable(
  state: SchemaState,
  name: string,
  actions: readonly TableAction[],
  options: CreateTableOptions | undefined,
): SchemaState {
  if (findTable(state, name) !== undefined) {
    throw new SchemaError(
      'table_exists',
      `The table "${name}" already exists.`,
      `Use schema.table('${name}', …) to change it, or drop it first.`,
    )
  }
  for (const action of actions) {
    if (action.type !== 'addColumn' && action.type !== 'addIndex') {
      throw new SchemaError(
        'not_allowed_in_create',
        `schema.create('${name}') can only add columns and indexes, but it asks to ${action.type}.`,
        `Define the table the way you want it, or change it later with schema.table('${name}', …).`,
      )
    }
  }
  const empty: TableState = {
    name,
    columns: [],
    indexes: [],
    ...(options?.global === true ? { global: true } : {}),
    ...(options?.internal === true ? { internal: true } : {}),
  }
  // The new table is visible while its own actions run, so a self-referencing key (parent_id) works.
  const withTable: SchemaState = { tables: [...state.tables, empty] }
  return applyTableActions(withTable, name, actions, 'create')
}

function alterTable(
  state: SchemaState,
  name: string,
  actions: readonly TableAction[],
): SchemaState {
  requireTable(state, name)
  return applyTableActions(state, name, actions, 'alter')
}

function applyTableActions(
  state: SchemaState,
  name: string,
  actions: readonly TableAction[],
  mode: 'create' | 'alter',
): SchemaState {
  let current = state
  for (const action of actions) current = applyTableAction(current, name, action, mode)
  // Checked once the whole callback has run: the slug source may be declared after the slug.
  assertSlugSourcesExist(requireTable(current, name))
  // Also checked at the end: t.tenant() and the (tenant, id) key may come after a foreign key.
  assertTenancy(current, requireTable(current, name))
  assertTenantRewrites(current, requireTable(current, name), actions)
  return current
}

/**
 * The rewrites the recorder makes on a tenant table, required again here, so operations that did
 * not come from the recorder (the replay sandbox's child answers with plain JSON) can't skip them
 * (F-05, F-14): in this batch, every unique index includes the tenant column, every foreign key
 * to a tenant table is composite, and afterwards the `(tenant, key)` unique index exists.
 */
function assertTenantRewrites(
  state: SchemaState,
  table: TableState,
  actions: readonly TableAction[],
): void {
  const tenant = tenantColumnOf(table)?.name
  if (tenant === undefined) return
  const refuse = (what: string): never => {
    throw new SchemaError(
      'invalid_tenancy',
      `The tenant table "${table.name}" ${what}.`,
      'Tenant tables are shaped by the schema builder (tenant-prefixed unique indexes, composite foreign keys): use it instead of changing operations by hand.',
    )
  }
  for (const action of actions) {
    if (action.type === 'addIndex' && action.index.unique && !action.index.columns.includes(tenant))
      refuse(`has the unique index "${action.index.name}" without its tenant column "${tenant}"`)
    if (action.type === 'addColumn') {
      const reference = action.column.references
      if (reference === undefined || action.column.tenant === true) continue
      const parent = reference.table === table.name ? table : findTable(state, reference.table)
      if (
        parent !== undefined &&
        tenantColumnOf(parent) !== undefined &&
        reference.tenant === undefined
      )
        refuse(
          `has a plain foreign key "${action.column.name}" to the tenant table "${reference.table}"`,
        )
    }
  }
  const key = table.columns.find((column) => column.kind === 'id' || column.primary === true)?.name
  if (key === undefined) return
  const keyed = table.indexes.some(
    (index) =>
      index.unique &&
      index.columns.length === 2 &&
      index.columns[0] === tenant &&
      index.columns[1] === key,
  )
  if (!keyed) refuse(`has no unique (${tenant}, ${key}) index`)
}

/**
 * The tenancy rules, checked on the finished table: one tenant column at most, never on a global
 * table, and every composite foreign key backed by the parent's unique `(tenant, key)` index.
 */
function assertTenancy(state: SchemaState, table: TableState): void {
  const tenants = table.columns.filter((column) => column.tenant === true)
  if (tenants.length > 1) {
    throw new SchemaError(
      'invalid_tenancy',
      `The table "${table.name}" has more than one tenant column (${tenants.map((c) => c.name).join(', ')}).`,
      'Keep a single t.tenant() per table.',
    )
  }
  if (tenants.length === 1 && table.global === true) {
    throw new SchemaError(
      'invalid_tenancy',
      `The table "${table.name}" is marked { global: true } but has a tenant column.`,
      'A table is either shared by every tenant (global) or belongs to one tenant (t.tenant()), not both.',
    )
  }
  for (const column of table.columns) {
    const tenant = column.references?.tenant
    const reference = column.references
    if (tenant === undefined || reference === undefined) continue
    if (reference.onDelete === 'set null') {
      // SET NULL would null the tenant column too (it is part of the key), which is NOT NULL.
      // PostgreSQL 15 can name the column; SQLite and MySQL can't, so it isn't portable.
      throw new SchemaError(
        'invalid_tenancy',
        `"${table.name}.${column.name}" uses nullOnDelete(), but between two tenant tables the key includes the tenant column, which can't be set to null.`,
        'Use cascadeOnDelete() or restrictOnDelete(), or clear the column in app code before deleting the parent.',
      )
    }
    const parent = requireTable(state, reference.table)
    const own = tenantColumnOf(table)
    const parentTenant = tenantColumnOf(parent)
    if (own?.name !== tenant.column || parentTenant?.name !== tenant.parentColumn) {
      throw new SchemaError(
        'invalid_tenancy',
        `The foreign key "${table.name}.${column.name}" joins tenant columns that don't exist ("${table.name}.${tenant.column}" → "${parent.name}.${tenant.parentColumn}").`,
        'Composite tenant keys are made by the recorder: keep t.tenant() on both tables.',
      )
    }
    const backed = parent.indexes.some(
      (index) =>
        index.unique &&
        index.columns.length === 2 &&
        index.columns[0] === tenant.parentColumn &&
        index.columns[1] === reference.column,
    )
    if (!backed) {
      throw new SchemaError(
        'invalid_tenancy',
        `The foreign key "${table.name}.${column.name}" points at "${parent.name}" (${tenant.parentColumn}, ${reference.column}), which has no unique index on those columns.`,
        `Point it at the parent's primary key, or add t.unique(['${reference.column}']) to "${parent.name}" (it becomes unique per tenant).`,
      )
    }
  }
}

function applyTableAction(
  state: SchemaState,
  tableName: string,
  action: TableAction,
  mode: 'create' | 'alter',
): SchemaState {
  const table = requireTable(state, tableName)
  switch (action.type) {
    case 'addColumn': {
      assertColumnCanBeAdded(state, table, action.column, mode)
      // Name the foreign key now (Laravel's convention), so later renames don't change it.
      const references = action.column.references
      const column =
        references === undefined || references.name !== undefined
          ? action.column
          : {
              ...action.column,
              references: { ...references, name: `${tableName}_${action.column.name}_foreign` },
            }
      return replaceTable(state, tableName, { ...table, columns: [...table.columns, column] })
    }
    case 'renameColumn':
      return renameColumn(state, table, action.from, action.to)
    case 'dropColumn':
      return dropColumn(state, table, action.name)
    case 'addIndex':
      assertIndexCanBeAdded(state, table, action.index)
      return replaceTable(state, tableName, { ...table, indexes: [...table.indexes, action.index] })
    case 'dropIndex':
      if (!table.indexes.some((index) => index.name === action.name)) {
        throw new SchemaError(
          'unknown_index',
          `The table "${tableName}" has no index named "${action.name}".`,
          `Existing indexes: ${listOrNone(table.indexes.map((index) => index.name))}.`,
        )
      }
      assertIndexNotNeeded(state, table, action.name)
      return replaceTable(state, tableName, {
        ...table,
        indexes: table.indexes.filter((index) => index.name !== action.name),
      })
    default:
      return unknownStep(action)
  }
}

/** A unique `(tenant, key)` index that a composite foreign key relies on can't be dropped. */
function assertIndexNotNeeded(state: SchemaState, table: TableState, name: string): void {
  const index = table.indexes.find((candidate) => candidate.name === name)
  if (index === undefined || !index.unique || index.columns.length !== 2) return
  for (const child of state.tables) {
    for (const column of child.columns) {
      const reference = column.references
      if (
        reference?.table === table.name &&
        reference.tenant?.parentColumn === index.columns[0] &&
        reference.column === index.columns[1]
      ) {
        throw new SchemaError(
          'invalid_tenancy',
          `Can't drop the index "${name}": the foreign key "${child.name}.${column.name}" relies on it.`,
          `Drop "${child.name}.${column.name}" first.`,
        )
      }
    }
  }
}

function assertColumnCanBeAdded(
  state: SchemaState,
  table: TableState,
  column: ColumnDef,
  mode: 'create' | 'alter',
): void {
  if (findColumn(table, column.name) !== undefined) {
    throw new SchemaError(
      'column_exists',
      `The table "${table.name}" already has a column "${column.name}".`,
      'Pick another name, or rename/drop the existing column first.',
    )
  }
  const isKey = column.kind === 'id' || column.primary === true
  if (
    isKey &&
    table.columns.some((existing) => existing.kind === 'id' || existing.primary === true)
  ) {
    throw new SchemaError(
      'invalid_column',
      `The table "${table.name}" already has a primary key.`,
      'A table can only have one t.id().',
    )
  }
  if (mode === 'alter') assertColumnCanBeAddedLater(table, column)
  if (column.references !== undefined) assertForeignKeyTarget(state, table, column)
}

function assertColumnCanBeAddedLater(table: TableState, column: ColumnDef): void {
  if (column.kind === 'id' || column.primary === true) {
    throw new SchemaError(
      'invalid_column',
      `Can't add a primary key to the existing table "${table.name}".`,
      'Add t.id() when the table is created.',
    )
  }
  // SQLite refuses this outright, and PostgreSQL only accepts it while the table is empty.
  if (!column.nullable && !('default' in column)) {
    throw new SchemaError(
      'invalid_column',
      `The new column "${table.name}.${column.name}" is required but has no default, so existing rows would have no value.`,
      'Make it .nullable(), or give it a .default(…).',
    )
  }
}

function assertForeignKeyTarget(state: SchemaState, table: TableState, column: ColumnDef): void {
  const reference = column.references
  if (reference === undefined) return
  const parent = findTable(state, reference.table)
  if (parent === undefined) {
    throw new SchemaError(
      'invalid_foreign_key',
      `"${table.name}.${column.name}" points to the table "${reference.table}", which doesn't exist yet.`,
      `Create "${reference.table}" in an earlier migration, or fix the name in .constrained('…').`,
    )
  }
  const target = findColumn(parent, reference.column)
  if (target === undefined) {
    throw new SchemaError(
      'invalid_foreign_key',
      `"${table.name}.${column.name}" points to "${reference.table}.${reference.column}", which doesn't exist.`,
      "Point it at the parent's id column.",
    )
  }
  // A key must have the parent key's type: MySQL and PostgreSQL refuse BIGINT → UUID outright.
  const uuidTarget = target.kind === 'uuid'
  if (uuidTarget !== (column.kind === 'uuid')) {
    throw new SchemaError(
      'invalid_foreign_key',
      `"${table.name}.${column.name}" is ${column.kind === 'uuid' ? 'a UUID' : 'an integer'} column, but "${reference.table}.${reference.column}" is ${uuidTarget ? 'a UUID' : 'an integer'}.`,
      uuidTarget
        ? `Use t.foreignUuid('${column.name}').constrained('${reference.table}').`
        : `Use t.foreignId('${column.name}').constrained('${reference.table}').`,
    )
  }
  if (reference.onDelete === 'set null' && !column.nullable) {
    throw new SchemaError(
      'invalid_foreign_key',
      `"${table.name}.${column.name}" uses nullOnDelete() but isn't nullable, so the database couldn't set it to null.`,
      'Add .nullable(), or use cascadeOnDelete() / restrictOnDelete() instead.',
    )
  }
}

function assertIndexCanBeAdded(state: SchemaState, table: TableState, index: IndexDef): void {
  // Index names are global in both SQLite and PostgreSQL, not per table.
  const clash = state.tables.find((other) =>
    other.indexes.some((existing) => existing.name === index.name),
  )
  if (clash !== undefined) {
    throw new SchemaError(
      'index_exists',
      `An index named "${index.name}" already exists (on "${clash.name}").`,
      'Give the index another name.',
    )
  }
  for (const column of index.columns) requireColumn(table, column)
}

function renameColumn(
  state: SchemaState,
  table: TableState,
  from: string,
  to: string,
): SchemaState {
  const column = requireColumn(table, from)
  if (findColumn(table, to) !== undefined) {
    throw new SchemaError(
      'column_exists',
      `Can't rename "${table.name}.${from}" to "${to}": that column already exists.`,
      'Drop or rename the other column first.',
    )
  }
  const renamed: TableState = {
    ...table,
    columns: table.columns.map((existing) => {
      const next = existing === column ? { ...existing, name: to } : existing
      // A composite tenant key of this table follows its renamed tenant column.
      const tenant = next.references?.tenant
      const keyed =
        tenant !== undefined && tenant.column === from && next.references !== undefined
          ? { ...next, references: { ...next.references, tenant: { ...tenant, column: to } } }
          : next
      // A slug built from the old name keeps following the column under its new name.
      return keyed.slugFrom === from ? { ...keyed, slugFrom: to } : keyed
    }),
    // Both engines keep the index (and its old name) and point it at the renamed column.
    indexes: table.indexes.map((index) => ({
      ...index,
      columns: index.columns.map((name) => (name === from ? to : name)),
    })),
  }
  const withTable = replaceTable(state, table.name, renamed)
  // Foreign keys in other tables follow the rename too, as they do in both databases.
  return mapReferences(withTable, (reference) => {
    if (reference.table !== table.name) return reference
    const column = reference.column === from ? to : reference.column
    const tenant =
      reference.tenant?.parentColumn === from
        ? { tenant: { ...reference.tenant, parentColumn: to } }
        : {}
    return { ...reference, column, ...tenant }
  })
}

function dropColumn(state: SchemaState, table: TableState, name: string): SchemaState {
  requireColumn(table, name)
  const slug = table.columns.find((column) => column.slugFrom === name)
  if (slug !== undefined) {
    throw new SchemaError(
      'invalid_slug_source',
      `Can't drop "${table.name}.${name}": the slug "${slug.name}" is built from it.`,
      `Change the slug's source first, or drop "${slug.name}" in the same migration before "${name}".`,
    )
  }
  const child = findReferencingColumn(state, table.name, name)
  if (child !== undefined) {
    throw new SchemaError(
      'invalid_foreign_key',
      `Can't drop "${table.name}.${name}": "${child}" still points to it.`,
      `Drop or change "${child}" first.`,
    )
  }
  const keyed = table.columns.find((column) => column.references?.tenant?.column === name)
  if (keyed !== undefined) {
    throw new SchemaError(
      'invalid_tenancy',
      `Can't drop the tenant column "${table.name}.${name}": the foreign key "${table.name}.${keyed.name}" includes it.`,
      `Drop "${table.name}.${keyed.name}" first.`,
    )
  }
  return replaceTable(state, table.name, {
    ...table,
    columns: table.columns.filter((column) => column.name !== name),
    // PostgreSQL drops every index that covers the column; the SQLite compiler drops them explicitly.
    indexes: table.indexes.filter((index) => !index.columns.includes(name)),
  })
}

function dropTable(state: SchemaState, name: string, ifExists: boolean): SchemaState {
  if (findTable(state, name) === undefined) {
    if (ifExists) return state
    throw new SchemaError(
      'unknown_table',
      `Can't drop "${name}": there is no such table.`,
      `Use schema.dropIfExists('${name}') if it may already be gone.`,
    )
  }
  const child = state.tables
    .filter((table) => table.name !== name)
    .flatMap((table) =>
      table.columns
        .filter((column) => column.references?.table === name)
        .map((column) => `${table.name}.${column.name}`),
    )[0]
  if (child !== undefined) {
    throw new SchemaError(
      'invalid_foreign_key',
      `Can't drop "${name}": "${child}" still points to it.`,
      `Drop "${child.split('.')[0] ?? ''}" first; in down(), drop tables in the reverse order you created them.`,
    )
  }
  return { tables: state.tables.filter((table) => table.name !== name) }
}

function renameTable(state: SchemaState, from: string, to: string): SchemaState {
  const table = requireTable(state, from)
  if (findTable(state, to) !== undefined) {
    throw new SchemaError(
      'table_exists',
      `Can't rename "${from}" to "${to}": that table already exists.`,
      'Pick another name, or drop the other table first.',
    )
  }
  const renamed = {
    tables: state.tables.map((existing) =>
      existing === table ? { ...table, name: to } : existing,
    ),
  }
  return mapReferences(renamed, (reference) =>
    reference.table === from ? { ...reference, table: to } : reference,
  )
}

function assertSlugSourcesExist(table: TableState): void {
  for (const column of table.columns) {
    if (column.slugFrom === undefined) continue
    const source = findColumn(table, column.slugFrom)
    if (source === undefined) {
      throw new SchemaError(
        'invalid_slug_source',
        `The slug "${table.name}.${column.name}" is built from "${column.slugFrom}", but that column doesn't exist.`,
        `Columns on "${table.name}": ${listOrNone(table.columns.map((existing) => existing.name))}.`,
      )
    }
  }
}

function requireTable(state: SchemaState, name: string): TableState {
  const table = findTable(state, name)
  if (table !== undefined) return table
  throw new SchemaError(
    'unknown_table',
    `There is no table "${name}" at this point in the migrations.`,
    `Known tables: ${listOrNone(state.tables.map((existing) => existing.name))}. Check the spelling and the migration order.`,
  )
}

function requireColumn(table: TableState, name: string): ColumnDef {
  const column = findColumn(table, name)
  if (column !== undefined) return column
  throw new SchemaError(
    'unknown_column',
    `The table "${table.name}" has no column "${name}".`,
    `Its columns are: ${listOrNone(table.columns.map((existing) => existing.name))}.`,
  )
}

function replaceTable(state: SchemaState, name: string, next: TableState): SchemaState {
  return { tables: state.tables.map((table) => (table.name === name ? next : table)) }
}

function mapReferences(
  state: SchemaState,
  update: (reference: NonNullable<ColumnDef['references']>) => NonNullable<ColumnDef['references']>,
): SchemaState {
  return {
    tables: state.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) =>
        column.references === undefined
          ? column
          : { ...column, references: update(column.references) },
      ),
    })),
  }
}

function findReferencingColumn(
  state: SchemaState,
  table: string,
  column: string,
): string | undefined {
  for (const candidate of state.tables) {
    for (const child of candidate.columns) {
      const reference = child.references
      if (reference?.table !== table) continue
      if (reference.column === column || reference.tenant?.parentColumn === column)
        return `${candidate.name}.${child.name}`
    }
  }
  return undefined
}

function listOrNone(names: readonly string[]): string {
  return names.length === 0 ? '(none)' : names.join(', ')
}
