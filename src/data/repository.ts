/**
 * The per-model repository: create, find, update, delete, restore and list, with tenancy,
 * soft deletes, policy filters and keyset pagination built in.
 *
 * Security properties (each has a test):
 * - **Tenant scope, twice.** For tenant models every statement carries `tenant_id = ?` *and*
 *   runs in a transaction with `set_config('app.tenant_id', …, true)`, so Postgres RLS enforces
 *   the same boundary (ADR-0007). A missing tenant fails closed with `TENANT_REQUIRED`.
 * - **Tenant is never input.** `tenant_id` comes from the scope, never from the payload.
 * - **References are checked in scope.** A `belongsTo` value must name a visible row of the
 *   target in the same tenant. Foreign keys alone would accept another tenant's id (FK checks
 *   bypass RLS), so this is a security check, not a convenience.
 * - **Policy filters narrow everything.** The scope's filter applies to reads *and* writes; a
 *   row the actor may not see is "not found", never "forbidden" (no enumeration).
 * - **Writes are checked after the fact.** A created or updated row must still match
 *   `scope.check` (default: the filter) inside the same transaction, or the write is rolled back
 *   (`PolicyViolationError`, 403): no create outside the actor's rows, no update moving a row out.
 * - **References respect visibility.** `scope.references` adds the target's policy to the
 *   reference check, so a client cannot link to rows it may not see.
 * - **Values are parameters.** All SQL comes from the model and the bound filter compiler.
 *
 * @module
 */

import type { PageInfo, SortDirective } from '../contracts/index.ts'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StrutvaneError,
  ValidationError,
} from '../core/index.ts'
import { frag, ident, join, render, type SqlFragment } from '../database/sql.ts'
import type { Database, Row } from '../database/types.ts'
import { columnName, type ModelDefinition } from '../model/define-model.ts'
import type { ModelRegistry } from '../model/registry.ts'
import { andAll, type BoundFilter } from '../query/bind.ts'
import { compileFilter } from '../query/compile.ts'
import { queryFields } from '../query/fields.ts'
import {
  decodeCursor,
  encodeCursor,
  orderByClause,
  resolveSort,
  SortError,
  type SortKey,
  seekPredicate,
} from '../query/sort.ts'
import { defaultNaming } from '../schema/compile.ts'
import { canonicalDatetime, decodeValue, encodeValue } from './values.ts'

/** A record as the repository returns it: API values by field key. */
export type DataRecord = Record<string, unknown> & { readonly id: string }

/** Which rows a call may see. */
export interface Scope {
  /** The tenant (required for tenant-scoped models). */
  readonly tenantId?: string | null
  /** Policy filter from the PermissionProvider, already bound. */
  readonly filter?: BoundFilter
  /**
   * What a row must satisfy **after** a create or update (the `WITH CHECK` of row-level
   * security, enforced on every engine). The write runs in a transaction; when the written row
   * does not match, the transaction is rolled back and {@link PolicyViolationError} (403) is
   * thrown. Defaults to `filter`, so a caller allowed to touch only some rows can never create a
   * row outside that set or move one out of it.
   */
  readonly check?: BoundFilter
  /**
   * Per `belongsTo` field key: the filter the referenced row must match (e.g. the target's `view`
   * policy). Without it a reference only has to exist in the same tenant, so a client could link
   * to (and learn about) rows it may not see.
   */
  readonly references?: Readonly<Record<string, BoundFilter>>
  /** Soft-deleted rows: hidden (default), included, or the only ones. */
  readonly trashed?: 'without' | 'with' | 'only'
}

/**
 * Options for a write ({@link Repository.create}, `update`, `delete`, `restore`).
 *
 * @example
 * await repo.create(input, scope, { onWrite: (record, tx) => audit.write(record, tx) })
 */
export interface WriteOptions {
  /**
   * Runs inside the write's transaction, after the row is written and checked, with the row (for
   * a delete: the row as it was) and the transaction. Throwing rolls the write back, so work that
   * must go with the write (an audit record, a counter) can never disagree with it.
   */
  readonly onWrite?: (record: DataRecord, tx: Database) => Promise<void>
}

/** A create or update would leave the row outside what the caller may write. 403. */
export class PolicyViolationError extends ForbiddenError {
  override readonly name = 'PolicyViolationError'
}

/** A page request. */
export type PageSpec =
  | { readonly kind: 'cursor'; readonly size: number; readonly cursor?: string }
  | { readonly kind: 'offset'; readonly size: number; readonly number: number }

/** Options for {@link Repository.list}. */
export interface ListOptions {
  readonly filter?: BoundFilter
  readonly search?: string
  readonly sort?: readonly SortDirective[]
  readonly page?: PageSpec
  /**
   * API keys the caller may sort and search on (e.g. the actor's filterable fields). When set,
   * a sort on any other field fails with `SortError`, and search silently skips searchable
   * fields outside it (search spans several fields, so narrowing it is not an error). Cursors
   * are bound to the sort keys, so they are covered too. Omitted: no extra restriction.
   */
  readonly allowedFields?: ReadonlySet<string>
  /** Count all matching rows (costly on large tables; opt-in). */
  readonly withTotal?: boolean
}

/** A page of records. */
export interface ListPage {
  readonly data: DataRecord[]
  readonly page: PageInfo
}

/** Thrown when a tenant-scoped model is used without a tenant. */
export class TenantRequiredError extends StrutvaneError {
  constructor() {
    super('TENANT_REQUIRED', { status: 403 })
  }
}

/** Options for {@link createRepository}. */
export interface RepositoryOptions {
  readonly db: Database
  readonly model: ModelDefinition
  /** Needed to check `belongsTo` references and load includes. */
  readonly registry?: ModelRegistry
  readonly now?: () => Date
  readonly ids: () => string
}

const ALIAS = 't'
const MAX_SEARCH = 200

/** The per-model data access API. */
export interface Repository {
  readonly model: ModelDefinition
  create(
    input: Readonly<Record<string, unknown>>,
    scope?: Scope,
    write?: WriteOptions,
  ): Promise<DataRecord>
  find(id: string, scope?: Scope): Promise<DataRecord | undefined>
  findOrFail(id: string, scope?: Scope): Promise<DataRecord>
  update(
    id: string,
    patch: Readonly<Record<string, unknown>>,
    scope?: Scope,
    write?: WriteOptions,
  ): Promise<DataRecord | undefined>
  /** Soft-deletes when the model has `softDeletes`, otherwise deletes. `false` if not found. */
  delete(id: string, scope?: Scope, write?: WriteOptions): Promise<boolean>
  /** Permanently deletes, even for soft-delete models. */
  forceDelete(id: string, scope?: Scope): Promise<boolean>
  /** Restores a soft-deleted row. `undefined` if no such deleted row is visible. */
  restore(id: string, scope?: Scope, write?: WriteOptions): Promise<DataRecord | undefined>
  list(options?: ListOptions, scope?: Scope): Promise<ListPage>
  count(filter?: BoundFilter, scope?: Scope): Promise<number>
  /** Load rows by id (visible in scope), in no particular order. */
  findMany(ids: readonly string[], scope?: Scope): Promise<DataRecord[]>
  /** Load rows whose `field` (a belongsTo) is one of `ids`. */
  findBy(
    field: string,
    ids: readonly string[],
    scope?: Scope,
    limit?: number,
  ): Promise<DataRecord[]>
}

/** Create the repository for a model. */
export function createRepository(options: RepositoryOptions): Repository {
  const { db, model, registry } = options
  const now = options.now ?? (() => new Date())
  const dialect = db.dialect
  const table = ident(model.table)
  const fields = queryFields(model)
  const fieldEntries = Object.entries(model.fields)

  const run = async <R extends Row>(fragment: SqlFragment, tx: Database): Promise<R[]> => {
    const { sql, params } = render(fragment, dialect)
    return tx.query<R>(sql, params)
  }

  const tenantOf = (scope: Scope): string | undefined => {
    if (!model.options.tenant) return undefined
    if (typeof scope.tenantId !== 'string' || scope.tenantId === '') throw new TenantRequiredError()
    return scope.tenantId
  }

  const inTx = async <T>(scope: Scope, fn: (tx: Database) => Promise<T>): Promise<T> => {
    const tenantId = tenantOf(scope)
    return db.transaction(fn, tenantId ? { tenantId } : {})
  }

  /** The WHERE conditions every statement on this model gets. */
  const scopeConditions = (scope: Scope): SqlFragment[] => {
    const out: SqlFragment[] = []
    const tenantId = tenantOf(scope)
    if (tenantId !== undefined) out.push(frag(`${ident(ALIAS)}."tenant_id" = ?`, [tenantId]))
    if (model.options.softDeletes) {
      const trashed = scope.trashed ?? 'without'
      if (trashed === 'without') out.push(frag(`${ident(ALIAS)}."deleted_at" IS NULL`))
      if (trashed === 'only') out.push(frag(`${ident(ALIAS)}."deleted_at" IS NOT NULL`))
    }
    if (scope.filter) out.push(compileFilter(scope.filter, { dialect, alias: ALIAS }))
    return out
  }

  const where = (conditions: readonly SqlFragment[]): SqlFragment =>
    conditions.length === 0
      ? frag('')
      : (() => {
          const j = join(conditions, ' AND ')
          return frag(` WHERE ${j.text}`, j.params)
        })()

  const decode = (row: Row): DataRecord => {
    const sys = row as unknown as SystemColumns
    const out: Record<string, unknown> = { id: String(sys.id).toLowerCase() }
    for (const [key, def] of fieldEntries) {
      out[key] = decodeValue(def.kind, def, row[columnName(key, def)])
    }
    if (model.options.timestamps) {
      Object.assign(out, {
        createdAt: canonicalDatetime(toDateInput(sys.created_at)),
        updatedAt: canonicalDatetime(toDateInput(sys.updated_at)),
      })
    }
    if (model.options.softDeletes) {
      const deleted = sys.deleted_at
      Object.assign(out, {
        deletedAt:
          deleted === null || deleted === undefined
            ? null
            : canonicalDatetime(toDateInput(deleted)),
      })
    }
    return out as DataRecord
  }

  /** Check that every belongsTo value names a visible row of its target, in the same tenant. */
  const checkReferences = async (
    values: Readonly<Record<string, unknown>>,
    scope: Scope,
    tx: Database,
  ): Promise<void> => {
    const issues: { path: string[]; code: string }[] = []
    for (const [key, def] of fieldEntries) {
      if (def.kind !== 'belongsTo' || values[key] === null || values[key] === undefined) continue
      const target = registry?.get(def.target ?? '')
      if (!target) continue // without a registry the database FK is the only check
      const conditions: SqlFragment[] = [frag('"id" = ?', [encodeValue(def, values[key], dialect)])]
      if (target.options.tenant) {
        const tenantId = scope.tenantId
        if (typeof tenantId !== 'string' || tenantId === '') throw new TenantRequiredError()
        conditions.push(frag('"tenant_id" = ?', [tenantId]))
      }
      if (target.options.softDeletes) conditions.push(frag('"deleted_at" IS NULL'))
      const visible = scope.references?.[key]
      if (visible) conditions.push(compileFilter(visible, { dialect }))
      const j = join(conditions, ' AND ')
      const rows = await run(
        frag(`SELECT "id" FROM ${ident(target.table)} WHERE ${j.text}`, j.params),
        tx,
      )
      if (rows.length === 0) issues.push({ path: [key], code: 'not_found' })
    }
    if (issues.length > 0) throw new ValidationError(issues)
  }

  const columnValues = (input: Readonly<Record<string, unknown>>): [string, unknown][] =>
    fieldEntries
      .filter(([key]) => Object.hasOwn(input, key) && input[key] !== undefined)
      .map(([key, def]) => [columnName(key, def), encodeValue(def, input[key], dialect)])

  const selectOne = async (
    id: string,
    scope: Scope,
    tx: Database,
  ): Promise<DataRecord | undefined> => {
    const rows = await run(
      join(
        [
          frag(`SELECT ${ident(ALIAS)}.* FROM ${table} AS ${ident(ALIAS)}`),
          where([frag(`${ident(ALIAS)}."id" = ?`, [id]), ...scopeConditions(scope)]),
          frag(' LIMIT 1'),
        ],
        '',
      ),
      tx,
    )
    return rows[0] ? decode(rows[0]) : undefined
  }

  /**
   * The post-write check (`WITH CHECK`): the row just written must match `scope.check` (default
   * `scope.filter`). Throwing inside the transaction rolls the write back.
   */
  const assertWritable = async (id: string, scope: Scope, tx: Database): Promise<void> => {
    const check = scope.check ?? scope.filter
    if (!check || check.op === 'true') return
    const visible = await selectOne(
      id,
      { ...unfiltered(scope), filter: check, trashed: 'with' },
      tx,
    )
    if (!visible) throw new PolicyViolationError()
  }

  const validId = (id: string): string | undefined =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? id.toLowerCase()
      : undefined

  const repo: Repository = {
    model,

    create: (input, scope = {}, write = {}) =>
      translateErrors(model, () =>
        inTx(scope, async (tx) => {
          await checkReferences(input, scope, tx)
          const id = options.ids()
          const cols: [string, unknown][] = [['id', id]]
          const tenantId = tenantOf(scope)
          if (tenantId !== undefined) cols.push(['tenant_id', tenantId])
          cols.push(...columnValues(input))
          if (model.options.timestamps) {
            const ts = now().toISOString()
            cols.push(['created_at', ts], ['updated_at', ts])
          }
          const names = cols.map(([c]) => ident(c)).join(', ')
          const marks = cols.map(() => '?').join(', ')
          await run(
            frag(
              `INSERT INTO ${table} (${names}) VALUES (${marks})`,
              cols.map(([, v]) => v),
            ),
            tx,
          )
          await assertWritable(id, scope, tx)
          const created = (await selectOne(
            id,
            { ...unfiltered(scope), trashed: 'with' },
            tx,
          )) as DataRecord
          await write.onWrite?.(created, tx)
          return created
        }),
      ),

    find: async (id, scope = {}) => {
      const clean = validId(id)
      if (!clean) return undefined
      return inTx(scope, (tx) => selectOne(clean, scope, tx))
    },

    async findOrFail(id, scope = {}) {
      const found = await repo.find(id, scope)
      if (!found) throw new NotFoundError(model.label)
      return found
    },

    update: (id, patch, scope = {}, write = {}) =>
      translateErrors(model, async () => {
        const clean = validId(id)
        if (!clean) return undefined
        return inTx(scope, async (tx) => {
          if (!(await selectOne(clean, scope, tx))) return undefined
          await checkReferences(patch, scope, tx)
          const cols = columnValues(patch)
          if (model.options.timestamps) cols.push(['updated_at', now().toISOString()])
          if (cols.length > 0) {
            const sets = join(
              cols.map(([c, v]) => frag(`${ident(c)} = ?`, [v])),
              ', ',
            )
            const conds = join([frag('"id" = ?', [clean]), ...unaliased(scope)], ' AND ')
            await run(
              frag(`UPDATE ${table} SET ${sets.text} WHERE ${conds.text}`, [
                ...sets.params,
                ...conds.params,
              ]),
              tx,
            )
          }
          await assertWritable(clean, scope, tx)
          const updated = await selectOne(clean, unfiltered(scope), tx)
          if (updated) await write.onWrite?.(updated, tx)
          return updated
        })
      }),

    delete: (id, scope = {}, write = {}) =>
      translateErrors(model, async () => {
        const clean = validId(id)
        if (!clean) return false
        return inTx(scope, async (tx) => {
          const existing = await selectOne(clean, scope, tx)
          if (!existing) return false
          const conds = join([frag('"id" = ?', [clean]), ...unaliased(scope)], ' AND ')
          if (model.options.softDeletes) {
            const ts = now().toISOString()
            const sets = model.options.timestamps
              ? '"deleted_at" = ?, "updated_at" = ?'
              : '"deleted_at" = ?'
            const vals = model.options.timestamps ? [ts, ts] : [ts]
            await run(
              frag(`UPDATE ${table} SET ${sets} WHERE ${conds.text}`, [...vals, ...conds.params]),
              tx,
            )
          } else {
            await run(frag(`DELETE FROM ${table} WHERE ${conds.text}`, conds.params), tx)
          }
          await write.onWrite?.(existing, tx)
          return true
        })
      }),

    forceDelete: (id, scope = {}) =>
      translateErrors(model, async () => {
        const clean = validId(id)
        if (!clean) return false
        const s: Scope = { ...scope, trashed: 'with' }
        return inTx(s, async (tx) => {
          if (!(await selectOne(clean, s, tx))) return false
          const conds = join([frag('"id" = ?', [clean]), ...unaliased(s)], ' AND ')
          await run(frag(`DELETE FROM ${table} WHERE ${conds.text}`, conds.params), tx)
          return true
        })
      }),

    restore: async (id, scope = {}, write = {}) => {
      if (!model.options.softDeletes) return undefined
      const clean = validId(id)
      if (!clean) return undefined
      const s: Scope = { ...scope, trashed: 'only' }
      return inTx(s, async (tx) => {
        if (!(await selectOne(clean, s, tx))) return undefined
        const conds = join([frag('"id" = ?', [clean]), ...unaliased(s)], ' AND ')
        const sets = model.options.timestamps
          ? '"deleted_at" = NULL, "updated_at" = ?'
          : '"deleted_at" = NULL'
        const vals = model.options.timestamps ? [now().toISOString()] : []
        await run(
          frag(`UPDATE ${table} SET ${sets} WHERE ${conds.text}`, [...vals, ...conds.params]),
          tx,
        )
        const restored = await selectOne(clean, { ...unfiltered(scope), trashed: 'with' }, tx)
        if (restored) await write.onWrite?.(restored, tx)
        return restored
      })
    },

    list: (opts = {}, scope = {}) =>
      inTx(scope, async (tx) => {
        // Checked before resolveSort, which still needs `id` for its implicit tiebreaker.
        const denied = opts.allowedFields
          ? opts.sort?.find((d) => !opts.allowedFields?.has(d.field))
          : undefined
        if (denied) throw new SortError(denied.field)
        const keys: SortKey[] = resolveSort(opts.sort ?? [], fields)
        const page: PageSpec = opts.page ?? { kind: 'cursor', size: 25 }
        const conditions = scopeConditions(scope)
        const search = searchFilter(opts.search, opts.allowedFields)
        const userFilter = andAll([
          ...(opts.filter ? [opts.filter] : []),
          ...(search ? [search] : []),
        ])
        if (userFilter.op !== 'true')
          conditions.push(compileFilter(userFilter, { dialect, alias: ALIAS }))
        const total = opts.withTotal ? await countWhere(conditions, tx) : undefined
        if (page.kind === 'cursor' && page.cursor !== undefined) {
          conditions.push(seekPredicate(keys, decodeCursor(page.cursor, keys), dialect, ALIAS))
        }
        const offset = page.kind === 'offset' ? (page.number - 1) * page.size : 0
        const rows = await run(
          join(
            [
              frag(`SELECT ${ident(ALIAS)}.* FROM ${table} AS ${ident(ALIAS)}`),
              where(conditions),
              frag(` ORDER BY ${orderByClause(keys, dialect, ALIAS)} LIMIT ? OFFSET ?`, [
                page.size + 1,
                offset,
              ]),
            ],
            '',
          ),
          tx,
        )
        const hasMore = rows.length > page.size
        const data = rows.slice(0, page.size).map(decode)
        const last = data.at(-1)
        const info: PageInfo = {
          size: page.size,
          hasMore,
          ...(page.kind === 'cursor' && hasMore && last
            ? { nextCursor: encodeCursor(keys, last) }
            : {}),
          ...(page.kind === 'offset' ? { number: page.number } : {}),
          ...(total !== undefined ? { total } : {}),
        }
        return { data, page: info }
      }),

    count: (filter, scope = {}) =>
      inTx(scope, (tx) => {
        const conditions = scopeConditions(scope)
        if (filter) conditions.push(compileFilter(filter, { dialect, alias: ALIAS }))
        return countWhere(conditions, tx)
      }),

    findMany: async (ids, scope = {}) => {
      const clean = [...new Set(ids.map(validId).filter((x): x is string => x !== undefined))]
      if (clean.length === 0) return []
      return inTx(scope, async (tx) => {
        const rows = await run(
          join(
            [
              frag(`SELECT ${ident(ALIAS)}.* FROM ${table} AS ${ident(ALIAS)}`),
              where([
                frag(`${ident(ALIAS)}."id" IN (${clean.map(() => '?').join(', ')})`, clean),
                ...scopeConditions(scope),
              ]),
            ],
            '',
          ),
          tx,
        )
        return rows.map(decode)
      })
    },

    findBy: async (field, ids, scope = {}, limit = 1000) => {
      const def = model.fields[field]
      if (def?.kind !== 'belongsTo')
        throw new TypeError(`${model.name}.${field} is not a belongsTo field`)
      const clean = [...new Set(ids.map(validId).filter((x): x is string => x !== undefined))]
      if (clean.length === 0) return []
      return inTx(scope, async (tx) => {
        const col = `${ident(ALIAS)}.${ident(columnName(field, def))}`
        const rows = await run(
          join(
            [
              frag(`SELECT ${ident(ALIAS)}.* FROM ${table} AS ${ident(ALIAS)}`),
              where([
                frag(`${col} IN (${clean.map(() => '?').join(', ')})`, clean),
                ...scopeConditions(scope),
              ]),
              frag(` ORDER BY ${ident(ALIAS)}."id" ASC LIMIT ?`, [limit]),
            ],
            '',
          ),
          tx,
        )
        return rows.map(decode)
      })
    },
  }

  /** Scope conditions without the alias, for UPDATE/DELETE (which take no alias on SQLite). */
  function unaliased(scope: Scope): SqlFragment[] {
    const out: SqlFragment[] = []
    const tenantId = tenantOf(scope)
    if (tenantId !== undefined) out.push(frag('"tenant_id" = ?', [tenantId]))
    if (model.options.softDeletes) {
      const trashed = scope.trashed ?? 'without'
      if (trashed === 'without') out.push(frag('"deleted_at" IS NULL'))
      if (trashed === 'only') out.push(frag('"deleted_at" IS NOT NULL'))
    }
    if (scope.filter) out.push(compileFilter(scope.filter, { dialect }))
    return out
  }

  function searchFilter(
    search: string | undefined,
    allowed: ReadonlySet<string> | undefined,
  ): BoundFilter | undefined {
    if (search === undefined || search.trim() === '') return undefined
    if (search.length > MAX_SEARCH || search.includes('\u0000')) {
      throw new ValidationError([
        { path: ['search'], code: 'too_long', params: { max: MAX_SEARCH } },
      ])
    }
    // Hidden fields never take part in search: a match would reveal their contents.
    // Nor do fields the caller may not filter on (allowedFields): skipped, not an error.
    const searchable = [...fields.values()].filter(
      (f) => f.def.searchable && !f.def.hidden && (allowed === undefined || allowed.has(f.key)),
    )
    if (searchable.length === 0) return undefined
    return {
      op: 'or',
      filters: searchable.map((f) => ({
        op: 'contains' as const,
        field: { key: f.key, column: f.column, kind: f.def.kind },
        value: search.trim(),
        caseSensitive: false,
      })),
    }
  }

  async function countWhere(conditions: readonly SqlFragment[], tx: Database): Promise<number> {
    const rows = await run<{ n: unknown }>(
      join(
        [frag(`SELECT COUNT(*) AS "n" FROM ${table} AS ${ident(ALIAS)}`), where(conditions)],
        '',
      ),
      tx,
    )
    return Number(rows[0]?.n ?? 0)
  }

  return repo
}

/** The scope without its policy filter (re-reading a row the call itself just wrote). */
function unfiltered(scope: Scope): Scope {
  const { filter: _filter, ...rest } = scope
  return rest
}

/** System columns every row may carry. */
interface SystemColumns {
  readonly id: unknown
  readonly created_at?: unknown
  readonly updated_at?: unknown
  readonly deleted_at?: unknown
}

function toDateInput(value: unknown): string | Date {
  return value instanceof Date ? value : String(value)
}

/** Driver error details we look at (pg / PGlite expose `code` and `constraint`). */
interface DriverError {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly message?: unknown
}

/**
 * Translate constraint violations into RFC-0003 errors: unique → 422 `unique` on the field;
 * a foreign key blocking a delete → 409 `RECORD_IN_USE`.
 */
async function translateErrors<T>(model: ModelDefinition, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof StrutvaneError) throw error
    const e = (error ?? {}) as DriverError
    const message = typeof e.message === 'string' ? e.message : ''
    const unique = e.code === '23505' || /UNIQUE constraint failed/.test(message)
    if (unique) {
      const key = uniqueFieldOf(
        model,
        typeof e.constraint === 'string' ? e.constraint : '',
        message,
      )
      if (key) throw new ValidationError([{ path: [key], code: 'unique' }], { cause: error })
      throw new ConflictError('CONFLICT', undefined, { cause: error })
    }
    // 23503 foreign_key_violation, 23001 restrict_violation (ON DELETE RESTRICT)
    if (e.code === '23503' || e.code === '23001' || /FOREIGN KEY constraint failed/.test(message)) {
      throw new ConflictError('RECORD_IN_USE', { resource: model.label }, { cause: error })
    }
    throw error
  }
}

function uniqueFieldOf(
  model: ModelDefinition,
  constraint: string,
  message: string,
): string | undefined {
  for (const [key, def] of Object.entries(model.fields)) {
    if (!def.unique) continue
    const col = columnName(key, def)
    if (constraint === defaultNaming('unique', model.table, col)) return key
    // SQLite: "UNIQUE constraint failed: invoices.tenant_id, invoices.number"
    if (message.split(/[\s,]+/).includes(`${model.table}.${col}`)) return key
  }
  return undefined
}
