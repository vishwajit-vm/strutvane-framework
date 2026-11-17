/**
 * The ORM's runtime schema: `.strutvane/schema.json`, written by `node strut migrate` and read at
 * boot.
 *
 * Why a JSON file and not generated code: the app reads it on every boot, so it must never be
 * able to run anything. {@link parseSchemaSnapshot} checks every field against the closed
 * vocabulary of `columns.ts` and fails closed: a hand-edited or truncated file stops the boot
 * with a {@link SchemaError} instead of giving the ORM a wrong idea of a table (for example a
 * tenant table that looks global).
 *
 * {@link parseOperations} applies the same checks to recorded operations, which is how the parent
 * process accepts what the replay sandbox's child sends back: only well-formed operations with
 * safe identifiers, never anything that could change the meaning of the generated SQL.
 *
 * @module
 */
import type {
  ColumnDef,
  ColumnKind,
  ForeignKeyDef,
  IndexDef,
  ReferentialAction,
  SchemaSnapshot,
  SchemaState,
  TableState,
} from './columns.ts'
import { COLUMN_LIMITS } from './columns.ts'
import { assertIdentifier, SchemaError } from './errors.ts'
import type { CreateTableOptions, SchemaOperation, TableAction } from './operations.ts'

/**
 * The snapshot of a replayed schema: tables by name, in creation order.
 *
 * @example
 * writeFileSync('.strutvane/schema.json', JSON.stringify(schemaSnapshot(replay.state), null, 2))
 */
export function schemaSnapshot(state: SchemaState): SchemaSnapshot {
  const tables: Record<string, TableState> = {}
  for (const table of state.tables) tables[table.name] = table
  return { version: 1, tables }
}

const KINDS: ReadonlySet<string> = new Set<ColumnKind>([
  'id',
  'integer',
  'bigInteger',
  'string',
  'text',
  'slug',
  'uuid',
  'decimal',
  'double',
  'boolean',
  'enum',
  'date',
  'timestamp',
  'json',
  'foreignId',
])
const ACTIONS: ReadonlySet<string> = new Set<ReferentialAction>([
  'cascade',
  'set null',
  'restrict',
  'no action',
])
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * Read and check a parsed `.strutvane/schema.json`. Anything unexpected (an unknown kind, a bad
 * identifier, a missing field, a table whose key differs from its name) is refused.
 *
 * @example
 * const snapshot = parseSchemaSnapshot(JSON.parse(readFileSync('.strutvane/schema.json', 'utf8')))
 */
export function parseSchemaSnapshot(json: unknown): SchemaSnapshot {
  return reported(
    () => readSnapshot(json),
    (where, problem) =>
      new SchemaError(
        'invalid_snapshot',
        `.strutvane/schema.json is not valid: ${where} ${problem}.`,
        'Regenerate it with `node strut migrate` instead of editing it by hand.',
      ),
  )
}

/**
 * Read and check recorded operations received as JSON (from the replay sandbox). Every name must
 * be a safe identifier and every column a well-formed definition; anything else is refused.
 *
 * @example
 * const up = parseOperations(message.up, '2026_01_01_000000_create_tags_table')
 */
export function parseOperations(json: unknown, migration: string): SchemaOperation[] {
  return reported(
    () =>
      bounded(json, 'operations', MAX_OPERATIONS).map((op, index) =>
        readOperation(op, `operations[${index}]`),
      ),
    (where, problem) => {
      const error = new SchemaError(
        'invalid_migration',
        `The recorded operations are not valid: ${where} ${problem}.`,
        'Only operations made by the schema builder are accepted. Check the migration for code that changes them.',
      )
      error.migration = `${migration}.ts`
      return error
    },
  )
}

function readSnapshot(json: unknown): SchemaSnapshot {
  const root = record(json, 'the file')
  if (root['version'] !== 1) fail('the file', 'version must be 1')
  const raw = record(root['tables'], 'tables')
  const tables: Record<string, TableState> = {}
  for (const [key, value] of Object.entries(raw)) {
    const table = parseTable(value, `tables.${key}`)
    if (table.name !== key) fail(`tables.${key}`, `its name is "${table.name}"`)
    tables[key] = table
  }
  return { version: 1, tables }
}

function readOperation(value: unknown, where: string): SchemaOperation {
  const raw = record(value, where)
  switch (raw['type']) {
    case 'createTable': {
      const options =
        raw['options'] === undefined ? undefined : record(raw['options'], `${where}.options`)
      const clean: CreateTableOptions | undefined =
        options === undefined
          ? undefined
          : {
              ...flag(options, 'global', `${where}.options`),
              ...flag(options, 'internal', `${where}.options`),
            }
      return {
        type: 'createTable',
        table: identifier(raw['table'], `${where}.table`),
        actions: readActions(raw['actions'], `${where}.actions`),
        ...(clean === undefined ? {} : { options: clean }),
      }
    }
    case 'alterTable':
      return {
        type: 'alterTable',
        table: identifier(raw['table'], `${where}.table`),
        actions: readActions(raw['actions'], `${where}.actions`),
      }
    case 'dropTable': {
      const ifExists = raw['ifExists']
      if (typeof ifExists !== 'boolean') fail(`${where}.ifExists`, 'must be true or false')
      return { type: 'dropTable', table: identifier(raw['table'], `${where}.table`), ifExists }
    }
    case 'renameTable':
      return {
        type: 'renameTable',
        from: identifier(raw['from'], `${where}.from`),
        to: identifier(raw['to'], `${where}.to`),
      }
    default:
      return fail(`${where}.type`, 'is not a schema operation')
  }
}

function readActions(value: unknown, where: string): TableAction[] {
  return bounded(value, where, MAX_ACTIONS).map((entry, index): TableAction => {
    const at = `${where}[${index}]`
    const raw = record(entry, at)
    switch (raw['type']) {
      case 'addColumn':
        return { type: 'addColumn', column: parseColumn(raw['column'], `${at}.column`) }
      case 'renameColumn':
        return {
          type: 'renameColumn',
          from: identifier(raw['from'], `${at}.from`),
          to: identifier(raw['to'], `${at}.to`),
        }
      case 'dropColumn':
        return { type: 'dropColumn', name: identifier(raw['name'], `${at}.name`) }
      case 'addIndex':
        return { type: 'addIndex', index: parseIndex(raw['index'], `${at}.index`) }
      case 'dropIndex':
        return { type: 'dropIndex', name: identifier(raw['name'], `${at}.name`) }
      default:
        return fail(`${at}.type`, 'is not a table action')
    }
  })
}

function parseTable(value: unknown, where: string): TableState {
  const raw = record(value, where)
  const columns = list(raw['columns'], `${where}.columns`).map((column, index) =>
    parseColumn(column, `${where}.columns[${index}]`),
  )
  const indexes = list(raw['indexes'], `${where}.indexes`).map((index, position) =>
    parseIndex(index, `${where}.indexes[${position}]`),
  )
  return {
    name: identifier(raw['name'], `${where}.name`),
    columns,
    indexes,
    ...flag(raw, 'global', where),
    ...flag(raw, 'internal', where),
  }
}

function parseColumn(value: unknown, where: string): ColumnDef {
  const raw = record(value, where)
  const kind = raw['kind']
  if (typeof kind !== 'string' || !KINDS.has(kind)) fail(`${where}.kind`, 'is not a column kind')
  const nullable = raw['nullable']
  if (typeof nullable !== 'boolean') fail(`${where}.nullable`, 'must be true or false')
  const out: { -readonly [K in keyof ColumnDef]: ColumnDef[K] } = {
    name: identifier(raw['name'], `${where}.name`),
    kind: kind as ColumnKind,
    nullable,
  }
  if ('default' in raw) {
    const fallback = raw['default']
    if (
      fallback !== null &&
      typeof fallback !== 'string' &&
      typeof fallback !== 'number' &&
      typeof fallback !== 'boolean'
    ) {
      fail(`${where}.default`, 'must be a literal')
    }
    out.default = fallback
  }
  if ('length' in raw) out.length = count(raw['length'], `${where}.length`, 1, COLUMN_LIMITS.length)
  if ('precision' in raw)
    out.precision = count(raw['precision'], `${where}.precision`, 1, COLUMN_LIMITS.precision)
  if ('scale' in raw)
    out.scale = count(raw['scale'], `${where}.scale`, 0, out.precision ?? COLUMN_LIMITS.precision)
  if ('values' in raw) {
    out.values = list(raw['values'], `${where}.values`).map((entry, index) =>
      text(entry, `${where}.values[${index}]`),
    )
  }
  if ('slugFrom' in raw) out.slugFrom = identifier(raw['slugFrom'], `${where}.slugFrom`)
  if ('comment' in raw) out.comment = text(raw['comment'], `${where}.comment`)
  if ('references' in raw) out.references = parseReference(raw['references'], `${where}.references`)
  return {
    ...out,
    ...flag(raw, 'primary', where),
    ...flag(raw, 'tenant', where),
    ...flag(raw, 'hidden', where),
    ...flag(raw, 'secret', where),
  }
}

function parseReference(value: unknown, where: string): ForeignKeyDef {
  const raw = record(value, where)
  const onDelete = raw['onDelete']
  if (typeof onDelete !== 'string' || !ACTIONS.has(onDelete)) {
    fail(`${where}.onDelete`, 'is not a referential action')
  }
  const tenant =
    raw['tenant'] === undefined
      ? {}
      : (() => {
          const key = record(raw['tenant'], `${where}.tenant`)
          return {
            tenant: {
              column: identifier(key['column'], `${where}.tenant.column`),
              parentColumn: identifier(key['parentColumn'], `${where}.tenant.parentColumn`),
            },
          }
        })()
  return {
    table: identifier(raw['table'], `${where}.table`),
    column: identifier(raw['column'], `${where}.column`),
    onDelete: onDelete as ReferentialAction,
    ...(raw['name'] === undefined ? {} : { name: identifier(raw['name'], `${where}.name`) }),
    ...tenant,
  }
}

function parseIndex(value: unknown, where: string): IndexDef {
  const raw = record(value, where)
  const unique = raw['unique']
  if (typeof unique !== 'boolean') fail(`${where}.unique`, 'must be true or false')
  return {
    name: identifier(raw['name'], `${where}.name`),
    columns: list(raw['columns'], `${where}.columns`).map((column, index) =>
      identifier(column, `${where}.columns[${index}]`),
    ),
    unique,
  }
}

function flag<K extends string>(
  raw: Readonly<Record<string, unknown>>,
  key: K,
  where: string,
): { [P in K]?: true } {
  const value = raw[key]
  if (value === undefined) return {}
  if (value !== true) fail(`${where}.${key}`, 'must be true when present')
  return { [key]: true } as { [P in K]?: true }
}

function record(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'must be an object')
  }
  return value as Readonly<Record<string, unknown>>
}

function list(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(where, 'must be a list')
  return value
}

function identifier(value: unknown, where: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(where, 'is not a valid identifier')
  assertIdentifier(value, 'column')
  return value
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(where, 'must be text')
  return value
}

function count(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(where, `must be a whole number from ${min} to ${max}`)
  }
  return value
}

/** The most operations one migration may record, and actions one operation may hold. */
const MAX_OPERATIONS = 1_000
const MAX_ACTIONS = 1_000

function bounded(value: unknown, where: string, max: number): readonly unknown[] {
  const items = list(value, where)
  if (items.length > max) fail(where, `has more than ${max} entries`)
  return items
}

/** A shape problem, turned into the right SchemaError by {@link reported}. */
class ShapeProblem extends Error {
  readonly where: string
  readonly problem: string
  constructor(where: string, problem: string) {
    super(`${where} ${problem}`)
    this.where = where
    this.problem = problem
  }
}

function fail(where: string, problem: string): never {
  throw new ShapeProblem(where, problem)
}

function reported<T>(read: () => T, toError: (where: string, problem: string) => SchemaError): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof ShapeProblem) throw toError(error.where, error.problem)
    // An identifier the snapshot regex allows but the recorder doesn't (too long, …).
    if (error instanceof SchemaError) throw toError('a name', error.message)
    throw error
  }
}
