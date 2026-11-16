/**
 * `migration({ up, down })` and the `schema` object migrations talk to.
 *
 * The `schema` object is a *recorder*: `schema.create(…)` doesn't create anything, it writes down
 * a {@link SchemaOperation}. That one design choice is what lets Strutvane read a project's schema
 * with no database at all: run every `up()` against a recorder, in file order, and fold the
 * operations together.
 *
 * The recorder also applies the tenancy rules (security review F-05, decision #92) while it
 * records, so the recorded operations, the folded state and the SQL all agree on them:
 * - in a table with a tenant column (`t.tenant()`), every unique index starts with that column
 *   (unique *per tenant*), and the table gets a unique `(tenant, id)` key;
 * - a foreign key from a tenant table to a tenant table is composite, `(tenant, x)` → parent
 *   `(tenant, id)`, so a row can never point at another tenant's parent.
 *
 * @module
 */
import { Blueprint } from './blueprint.ts'
import { type ColumnDef, findTable, type IndexDef, type SchemaState } from './columns.ts'
import { assertIdentifier, SchemaError } from './errors.ts'
import type { CreateTableOptions, SchemaOperation, TableAction } from './operations.ts'

/**
 * What a migration's `up` and `down` receive: Laravel's `Schema` facade, as a parameter.
 *
 * Passing it in (instead of importing a global) keeps migrations pure functions of their input,
 * which is exactly what makes offline replay possible.
 *
 * @example
 * up(schema) {
 *   schema.create('posts', (t) => { t.id(); t.string('title') })
 * }
 */
export interface SchemaBuilder {
  /**
   * Create a table. Laravel's `Schema::create`. `{ global: true }` marks shared reference data
   * every tenant may see; `{ internal: true }` marks framework bookkeeping with no API or UI.
   */
  create(table: string, define: (t: Blueprint) => void, options?: CreateTableOptions): void
  /** Change an existing table: add, rename or drop columns and indexes. Laravel's `Schema::table`. */
  table(table: string, define: (t: Blueprint) => void): void
  /** Drop a table that must exist. */
  drop(table: string): void
  /** Drop a table if it exists; the usual choice in `down()`. */
  dropIfExists(table: string): void
  /** Rename a table. */
  rename(from: string, to: string): void
  /**
   * `true` if the table exists *at this point in the migration history*. Answered from the
   * recorded state, so it works offline and gives the same answer the database would.
   */
  hasTable(table: string): boolean
  /** `true` if the column exists at this point in the migration history. */
  hasColumn(table: string, column: string): boolean
}

/**
 * A migration file's default export.
 *
 * @example
 * export default migration({
 *   up(schema) { schema.create('tags', (t) => { t.id(); t.string('name') }) },
 *   down(schema) { schema.dropIfExists('tags') },
 * })
 */
export interface Migration {
  /** Apply the change. */
  up(schema: SchemaBuilder): void
  /** Undo exactly what `up` did. */
  down(schema: SchemaBuilder): void
}

/**
 * Declare a migration. It's an identity function: it exists for the types (so `schema` and `t`
 * are inferred inside `up` and `down`) and as a marker the replay sandbox looks for.
 *
 * @example
 * export default migration({ up(schema) {}, down(schema) {} })
 */
export function migration(definition: Migration): Migration {
  return definition
}

/**
 * Record what one `up()` or `down()` call does, without a database.
 *
 * `stateBefore` answers `hasTable` / `hasColumn` (so migrations that branch on them still record
 * the right operations) and tells the tenancy rules which tables are tenant tables.
 *
 * @example
 * const ops = recordOperations((schema) => schema.drop('posts'), state)
 * // [{ type: 'dropTable', table: 'posts', ifExists: false }]
 */
export function recordOperations(
  run: (schema: SchemaBuilder) => void,
  stateBefore: SchemaState,
): SchemaOperation[] {
  const recorder = new SchemaRecorder(stateBefore)
  try {
    // Typed as void, but an `async up()` still compiles (a Promise is assignable to void). Its
    // operations after the first `await` would be recorded too late, so refuse it outright.
    refuseThenable(run(recorder), 'up() and down()')
  } finally {
    recorder.seal()
  }
  return recorder.operations
}

/** Migrations are recorded synchronously: a returned promise means operations would be lost. */
function refuseThenable(result: unknown, what: string): void {
  if (
    typeof result === 'object' &&
    result !== null &&
    'then' in result &&
    typeof result.then === 'function'
  ) {
    throw new SchemaError(
      'async_migration',
      `${what} returned a promise. Migrations are recorded synchronously, so everything after the first await would be missing from the types, metadata and SQL.`,
      'Remove async/await from the migration. Data changes that need I/O belong in a seeder or a data migration, not in the schema.',
    )
  }
}

/** What the recorder remembers about a table while it records. */
interface TrackedTable {
  readonly columns: Set<string>
  /** The tenant column's name, when the table has one. */
  tenant: string | undefined
  /** The primary key column's name (`t.id()` or `t.uuid(…).primary()`). */
  primaryKey: string | undefined
  /** Index name → its columns. */
  readonly indexes: Map<string, readonly string[]>
  global: boolean
}

/**
 * The recorder behind {@link SchemaBuilder}.
 *
 * It tracks just enough of the state as it goes to answer `hasTable` / `hasColumn` truthfully
 * after earlier calls in the same migration (for example `create` then `hasTable`), and to apply
 * the tenancy rules.
 */
class SchemaRecorder implements SchemaBuilder {
  readonly operations: SchemaOperation[] = []
  readonly #state: SchemaState
  /**
   * Tables touched so far, tracked lazily from the state (a replay records every migration twice,
   * so building this for every table up front was most of the recorder's cost). `null` = dropped
   * or renamed away in this recording.
   */
  readonly #tables = new Map<string, TrackedTable | null>()
  #sealed = false

  constructor(state: SchemaState) {
    this.#state = state
  }

  /** The tracked table, from this recording or (first time) from the state before it. */
  #get(name: string): TrackedTable | undefined {
    if (this.#tables.has(name)) return this.#tables.get(name) ?? undefined
    const table = findTable(this.#state, name)
    if (table === undefined) return undefined
    const tracked: TrackedTable = {
      columns: new Set(table.columns.map((column) => column.name)),
      tenant: table.columns.find((column) => column.tenant === true)?.name,
      primaryKey: table.columns.find((column) => column.kind === 'id' || column.primary)?.name,
      indexes: new Map(table.indexes.map((index) => [index.name, index.columns])),
      global: table.global === true,
    }
    this.#tables.set(name, tracked)
    return tracked
  }

  /** Stop recording: a call that arrives after up()/down() returned is a bug, never a silent no-op. */
  seal(): void {
    this.#sealed = true
  }

  #assertOpen(): void {
    if (this.#sealed) {
      throw new SchemaError(
        'async_migration',
        'The schema builder was used after the migration returned (a stored reference, a timer or an await).',
        'Call schema methods only synchronously inside up() and down().',
      )
    }
  }

  create(table: string, define: (t: Blueprint) => void, options?: CreateTableOptions): void {
    this.#assertOpen()
    assertIdentifier(table, 'table')
    const clean = cleanOptions(table, options)
    const tracked: TrackedTable = {
      columns: new Set(),
      tenant: undefined,
      primaryKey: undefined,
      indexes: new Map(),
      global: clean?.global === true,
    }
    const actions = this.#withTenancy(table, tracked, runBlueprint(table, define))
    this.operations.push({
      type: 'createTable',
      table,
      actions,
      ...(clean === undefined ? {} : { options: clean }),
    })
    this.#tables.set(table, tracked)
  }

  table(table: string, define: (t: Blueprint) => void): void {
    this.#assertOpen()
    const existing = this.#get(table)
    const tracked = existing ?? {
      columns: new Set<string>(),
      tenant: undefined,
      primaryKey: undefined,
      indexes: new Map<string, readonly string[]>(),
      global: false,
    }
    const actions = this.#withTenancy(table, tracked, runBlueprint(table, define))
    this.operations.push({ type: 'alterTable', table, actions })
    if (existing !== undefined) this.#tables.set(table, tracked)
  }

  drop(table: string): void {
    this.#assertOpen()
    this.operations.push({ type: 'dropTable', table, ifExists: false })
    this.#tables.set(table, null)
  }

  dropIfExists(table: string): void {
    this.#assertOpen()
    this.operations.push({ type: 'dropTable', table, ifExists: true })
    this.#tables.set(table, null)
  }

  rename(from: string, to: string): void {
    this.#assertOpen()
    assertIdentifier(to, 'table')
    this.operations.push({ type: 'renameTable', from, to })
    const tracked = this.#get(from)
    this.#tables.set(from, null)
    if (tracked !== undefined) this.#tables.set(to, tracked)
  }

  hasTable(table: string): boolean {
    return this.#get(table) !== undefined
  }

  hasColumn(table: string, column: string): boolean {
    return this.#get(table)?.columns.has(column) ?? false
  }

  /**
   * Track the actions on `tracked` and rewrite them for tenancy: tenant-prefixed unique indexes,
   * the `(tenant, id)` key, and composite foreign keys between tenant tables.
   */
  #withTenancy(table: string, tracked: TrackedTable, actions: TableAction[]): TableAction[] {
    for (const action of actions) track(tracked, action)
    const tenant = tracked.tenant
    if (tenant === undefined) return actions
    if (tracked.global) {
      throw new SchemaError(
        'invalid_tenancy',
        `The table "${table}" is marked { global: true } but has the tenant column "${tenant}".`,
        'A table is either shared by every tenant (global) or belongs to one tenant (t.tenant()), not both.',
      )
    }
    const out: TableAction[] = []
    for (const action of actions) {
      if (
        action.type === 'addIndex' &&
        action.index.unique &&
        !action.index.columns.includes(tenant)
      ) {
        const index = perTenantIndex(table, tenant, action.index)
        tracked.indexes.delete(action.index.name)
        tracked.indexes.set(index.name, index.columns)
        out.push({ type: 'addIndex', index })
      } else if (action.type === 'addColumn' && action.column.references !== undefined) {
        out.push({ type: 'addColumn', column: this.#compositeKey(table, tenant, action.column) })
      } else {
        out.push(action)
      }
    }
    const key = tracked.primaryKey
    const hasKey = [...tracked.indexes.values()].some(
      (columns) => columns.length === 2 && columns[0] === tenant && columns[1] === key,
    )
    if (key !== undefined && !hasKey) {
      const name = `${table}_${tenant}_${key}_unique`
      assertIdentifier(name, 'index')
      tracked.indexes.set(name, [tenant, key])
      out.push({ type: 'addIndex', index: { name, columns: [tenant, key], unique: true } })
    }
    return out
  }

  /** A foreign key from a tenant table: composite when the parent is a tenant table too. */
  #compositeKey(table: string, tenant: string, column: ColumnDef): ColumnDef {
    const reference = column.references
    if (reference === undefined || column.tenant === true) return column
    const parentTenant = reference.table === table ? tenant : this.#get(reference.table)?.tenant
    if (parentTenant === undefined) return column
    return {
      ...column,
      references: { ...reference, tenant: { column: tenant, parentColumn: parentTenant } },
    }
  }
}

/** Record one action's effect on the tracked table. */
function track(tracked: TrackedTable, action: TableAction): void {
  switch (action.type) {
    case 'addColumn':
      tracked.columns.add(action.column.name)
      if (action.column.tenant === true) {
        if (tracked.tenant !== undefined && tracked.tenant !== action.column.name) {
          throw new SchemaError(
            'invalid_tenancy',
            `A table can have only one tenant column, but "${action.column.name}" was added next to "${tracked.tenant}".`,
            'Keep a single t.tenant() per table.',
          )
        }
        tracked.tenant = action.column.name
      }
      if (action.column.kind === 'id' || action.column.primary === true) {
        tracked.primaryKey = action.column.name
      }
      return
    case 'dropColumn':
      tracked.columns.delete(action.name)
      if (tracked.tenant === action.name) tracked.tenant = undefined
      if (tracked.primaryKey === action.name) tracked.primaryKey = undefined
      for (const [name, columns] of tracked.indexes) {
        if (columns.includes(action.name)) tracked.indexes.delete(name)
      }
      return
    case 'renameColumn': {
      tracked.columns.delete(action.from)
      tracked.columns.add(action.to)
      if (tracked.tenant === action.from) tracked.tenant = action.to
      if (tracked.primaryKey === action.from) tracked.primaryKey = action.to
      for (const [name, columns] of tracked.indexes) {
        tracked.indexes.set(
          name,
          columns.map((column) => (column === action.from ? action.to : column)),
        )
      }
      return
    }
    case 'addIndex':
      tracked.indexes.set(action.index.name, action.index.columns)
      return
    case 'dropIndex':
      tracked.indexes.delete(action.name)
      return
  }
}

/**
 * The per-tenant version of a unique index. A name that followed Laravel's convention is renamed
 * with the tenant column in it (`labels_tenant_id_name_unique`); a custom name is kept.
 */
function perTenantIndex(table: string, tenant: string, index: IndexDef): IndexDef {
  const columns = [tenant, ...index.columns]
  const conventional = `${table}_${index.columns.join('_')}_unique`
  const name = index.name === conventional ? `${table}_${columns.join('_')}_unique` : index.name
  assertIdentifier(name, 'index')
  return { name, columns, unique: true }
}

/** Check the third argument of `schema.create` and drop `false` flags. */
function cleanOptions(
  table: string,
  options: CreateTableOptions | undefined,
): CreateTableOptions | undefined {
  if (options === undefined) return undefined
  if (typeof options !== 'object' || options === null) {
    throw new SchemaError(
      'invalid_migration',
      `The options for schema.create('${table}') must be an object.`,
      'Pass { global: true } or { internal: true }, or leave the argument out.',
    )
  }
  for (const key of Object.keys(options)) {
    if (key !== 'global' && key !== 'internal') {
      throw new SchemaError(
        'invalid_migration',
        `schema.create('${table}') got an unknown option "${key}".`,
        'The options are { global: true } and { internal: true }.',
      )
    }
  }
  const global = options.global === true
  const internal = options.internal === true
  if (!global && !internal) return undefined
  return { ...(global ? { global: true } : {}), ...(internal ? { internal: true } : {}) }
}

function runBlueprint(table: string, define: (t: Blueprint) => void): TableAction[] {
  const blueprint = new Blueprint(table)
  refuseThenable(define(blueprint), `The callback for "${table}"`)
  return blueprint.toActions()
}

/**
 * Check that a module's default export looks like a migration, with a friendly error if not.
 *
 * @example
 * const m = assertMigration((await import(url)).default, 'create_posts_table.ts')
 */
export function assertMigration(value: unknown, file: string): Migration {
  if (
    typeof value === 'object' &&
    value !== null &&
    'up' in value &&
    'down' in value &&
    typeof value.up === 'function' &&
    typeof value.down === 'function'
  ) {
    return value as Migration
  }
  throw new SchemaError(
    'invalid_migration',
    `${file} doesn't default-export a migration.`,
    'Make the file end with `export default migration({ up(schema) { … }, down(schema) { … } })`.',
  )
}
