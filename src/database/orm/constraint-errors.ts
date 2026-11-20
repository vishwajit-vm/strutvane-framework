/**
 * Constraint violations, translated from driver errors into ORM errors that name the columns.
 *
 * Why: a duplicate e-mail or a missing customer is a normal user mistake, not a crash. Left
 * alone, the driver's error becomes a 500 whose cause is engine-specific text (`UNIQUE constraint
 * failed: customers.email`, `Duplicate entry 'a@b.test' for key …`, SQLSTATE 23505). Here every
 * engine's error becomes one of two errors with stable codes and the affected columns, and the
 * HTTP layer renders them as RFC-0003 problems (`unique` / `not_found` issues on the field, or a
 * 409 `record_in_use`). The driver error is kept as `cause`, for the server log only.
 *
 * | | SQLite | PostgreSQL / PGlite | MySQL / MariaDB |
 * |---|---|---|---|
 * | unique | message `UNIQUE constraint failed: t.a, t.b` | SQLSTATE 23505 + `constraint` / `detail` | errno 1062, `for key '[t.]name'` |
 * | foreign key | message `FOREIGN KEY constraint failed` (no column) | 23503 / 23001 + `detail` | errno 1452 (child), 1451 (parent) |
 *
 * @module
 */
import { tableState } from '../schema/registry.ts'
import type { TableState } from '../schema/snapshot.ts'
import { OrmError } from './errors.ts'
import { tenantColumn } from './tenant-scope.ts'

/**
 * A write would duplicate a value a unique index protects. `columns` are the request-facing
 * columns of that index (the tenant column of a per-tenant index is left out); empty when the
 * engine did not say which index it was.
 *
 * @example
 * try { await Customer.create({ email }) } catch (error) { if (error instanceof UniqueViolationError) error.columns } // ['email']
 */
export class UniqueViolationError extends OrmError {
  override readonly name = 'UniqueViolationError'
  /** The table written to. */
  readonly table: string
  /** The duplicated columns, without the tenant column. */
  readonly columns: readonly string[]

  constructor(table: string, columns: readonly string[], options: { readonly cause: unknown }) {
    super(
      'unique_violation',
      columns.length === 0
        ? `A row in "${table}" already has that unique value.`
        : `A row in "${table}" already has that ${columns.join(' + ')}. Choose another value, or update the existing row.`,
    )
    this.table = table
    this.columns = Object.freeze([...columns])
    this.cause = options.cause
  }
}

/**
 * A foreign key refused the write: `missing` when a row points at a parent that doesn't exist
 * (insert or update), `in_use` when a parent row is still referenced (delete).
 *
 * @example
 * if (error instanceof ReferenceViolationError && error.kind === 'missing') error.columns // ['customer_id']
 */
export class ReferenceViolationError extends OrmError {
  override readonly name = 'ReferenceViolationError'
  /** The table written to. */
  readonly table: string
  /** Which side failed. */
  readonly kind: 'missing' | 'in_use'
  /** The foreign key columns, when the engine named them. */
  readonly columns: readonly string[]

  constructor(
    table: string,
    kind: 'missing' | 'in_use',
    columns: readonly string[],
    options: { readonly cause: unknown },
  ) {
    super(
      'reference_violation',
      kind === 'missing'
        ? `"${table}" refers to a row that does not exist${columns.length === 0 ? '' : ` (${columns.join(', ')})`}. Point it at an existing row.`
        : `This "${table}" row is still referenced by other rows, so it can't be deleted. Delete or re-point those rows first.`,
    )
    this.table = table
    this.kind = kind
    this.columns = Object.freeze([...columns])
    this.cause = options.cause
  }
}

/**
 * Turn a driver error from a write on `table` into a {@link UniqueViolationError} or a
 * {@link ReferenceViolationError}; `undefined` when it is neither (rethrow it unchanged).
 * `operation` decides what a foreign-key failure means on SQLite, whose message names no side.
 *
 * @example
 * catch (error) { throw translateConstraintError(error, 'customers', 'write') ?? error }
 */
export function translateConstraintError(
  error: unknown,
  table: string,
  operation: 'write' | 'delete',
): OrmError | undefined {
  if (error instanceof OrmError || typeof error !== 'object' || error === null) return undefined
  const code = property(error, 'code')
  const errno = property(error, 'errno')
  const message = error instanceof Error ? error.message : ''
  const state = safeTableState(table)
  if (code === '23505' || code === 'ER_DUP_ENTRY' || errno === 1062) {
    const columns =
      columnsFromIndex(state, stringProperty(error, 'constraint')) ??
      columnsFromIndex(state, mysqlKeyName(message)) ??
      columnsFromPostgresDetail(stringProperty(error, 'detail')) ??
      []
    return new UniqueViolationError(table, requestColumns(columns), { cause: error })
  }
  const sqliteUnique = /UNIQUE constraint failed: (.+)$/m.exec(message)?.[1]
  if (sqliteUnique !== undefined) {
    const columns = sqliteUnique
      .split(',')
      .map((part) => part.trim())
      .map((part) => (part.startsWith(`${table}.`) ? part.slice(table.length + 1) : part))
    return new UniqueViolationError(table, requestColumns(columns), { cause: error })
  }
  if (code === '23503' || code === '23001') {
    const detail = stringProperty(error, 'detail') ?? ''
    const inUse = code === '23001' || /still referenced/.test(detail)
    const columns = inUse ? [] : (columnsFromPostgresDetail(detail) ?? [])
    return new ReferenceViolationError(table, inUse ? 'in_use' : 'missing', columns, {
      cause: error,
    })
  }
  if (errno === 1452 || code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_NO_REFERENCED_ROW')
    return new ReferenceViolationError(table, 'missing', mysqlForeignKeyColumns(message), {
      cause: error,
    })
  if (errno === 1451 || code === 'ER_ROW_IS_REFERENCED_2' || code === 'ER_ROW_IS_REFERENCED')
    return new ReferenceViolationError(table, 'in_use', [], { cause: error })
  if (/FOREIGN KEY constraint failed/.test(message))
    return operation === 'delete'
      ? new ReferenceViolationError(table, 'in_use', [], { cause: error })
      : new ReferenceViolationError(table, 'missing', soleForeignKey(state), { cause: error })
  return undefined
}

function property(error: object, key: string): unknown {
  return key in error ? Reflect.get(error, key) : undefined
}

function stringProperty(error: object, key: string): string | undefined {
  const value = property(error, key)
  return typeof value === 'string' ? value : undefined
}

/** The table's state, or `undefined` (a translation must never throw a second error). */
function safeTableState(table: string): TableState | undefined {
  try {
    return tableState(table)
  } catch {
    return undefined
  }
}

/** The columns of a named index (`PRIMARY` / `<table>_pkey` → the key), when the snapshot knows it. */
function columnsFromIndex(
  state: TableState | undefined,
  name: string | undefined,
): readonly string[] | undefined {
  if (state === undefined || name === undefined) return undefined
  if (name === 'PRIMARY' || name === `${state.name}_pkey`) return ['id']
  return state.indexes.find((index) => index.name === name)?.columns
}

/** MySQL 8 says `for key 'customers.customers_email_unique'`, MariaDB `for key 'customers_email_unique'`. */
function mysqlKeyName(message: string): string | undefined {
  const key = /for key '([^']+)'\s*$/.exec(message)?.[1]
  if (key === undefined) return undefined
  const dot = key.lastIndexOf('.')
  return dot === -1 ? key : key.slice(dot + 1)
}

/** PostgreSQL: `Key (tenant_id, email)=(…) already exists.` → the column list. */
function columnsFromPostgresDetail(detail: string | undefined): readonly string[] | undefined {
  const list = detail === undefined ? undefined : /Key \(([^)]+)\)=/.exec(detail)?.[1]
  return list?.split(',').map((column) => column.trim().replace(/^"|"$/g, ''))
}

/** MySQL: ``… FOREIGN KEY (`customer_id`) REFERENCES …`` → `['customer_id']`. */
function mysqlForeignKeyColumns(message: string): string[] {
  const list = /FOREIGN KEY \(([^)]+)\)/.exec(message)?.[1]
  return list === undefined ? [] : list.split(',').map((column) => column.trim().replace(/`/g, ''))
}

/**
 * SQLite never says which foreign key failed. When the table has exactly one, it can only be
 * that one; with several, no column is named (a 409 instead of a guess on the wrong field).
 */
function soleForeignKey(state: TableState | undefined): string[] {
  const keys = state?.columns.filter((column) => column.references !== undefined) ?? []
  const [only] = keys
  return keys.length === 1 && only !== undefined ? requestColumns([only.name]) : []
}

/** The columns a request can do something about: never the tenant column (it is ours). */
function requestColumns(columns: readonly string[]): string[] {
  const tenant = tenantColumn()
  return columns.filter((column) => column !== tenant && /^[a-z_][a-z0-9_]*$/.test(column))
}
