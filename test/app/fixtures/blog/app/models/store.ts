/**
 * The fixture's in-memory "database": one per app (bound in its container), so two apps in one
 * test never share rows. The models below implement the `ResourceModel` contract on top of it,
 * the way the ORM will.
 */
import { type Token, token } from '../../../../../../src/core/container.ts'
import { type IssueInput, ValidationError } from '../../../../../../src/core/errors/errors.ts'
import { currentApplication } from '../../../../../../src/foundation/current.ts'
import type { Constraint, ResourceValue } from '../../../../../../src/http/app/resource-model.ts'

/** Rows are plain objects keyed by column. */
export type Row = Record<string, ResourceValue>

/** One table. */
export interface Table {
  rows: Row[]
  nextId: number
}

/** The database: tables by name. */
export class BlogDb {
  readonly tables: Map<string, Table> = new Map()

  table(name: string): Table {
    let table = this.tables.get(name)
    if (table === undefined) {
      table = { rows: [], nextId: 1 }
      this.tables.set(name, table)
    }
    return table
  }

  insert(name: string, row: Row): Row {
    const table = this.table(name)
    const stored = { ...row, id: table.nextId++ }
    table.rows.push(stored)
    return stored
  }
}

/** The container token for the fixture database. */
export const BlogDbToken: Token<BlogDb> = token<BlogDb>('blog.db')

/** The current app's database. */
export function db(): BlogDb {
  return currentApplication('the blog fixture').container.make(BlogDbToken)
}

/**
 * Run `work` as one transaction over the in-memory tables: every row is copied first and put
 * back when `work` throws, the way the ORM's database transaction rolls back.
 */
export async function inTransaction<TResult>(work: () => Promise<TResult>): Promise<TResult> {
  const tables = db().tables
  const saved = new Map(
    [...tables].map(([name, table]) => [
      name,
      { rows: table.rows.map((row) => ({ ...row })), nextId: table.nextId, live: [...table.rows] },
    ]),
  )
  try {
    return await work()
  } catch (error) {
    for (const [name, copy] of saved) {
      const table = tables.get(name)
      if (table === undefined) continue
      // Restore the row objects in place, so records already holding them see the old values.
      table.rows = copy.live
      for (const [index, row] of copy.live.entries()) {
        for (const key of Object.keys(row)) delete row[key]
        Object.assign(row, copy.rows[index])
      }
      table.nextId = copy.nextId
    }
    throw error
  }
}

/** Does a row match the constraints (ANDed; anyOf ORed)? */
export function matches(row: Row, constraints: readonly Constraint[]): boolean {
  return constraints.every((constraint) =>
    'anyOf' in constraint
      ? constraint.anyOf.some((inner) => matches(row, [inner]))
      : row[constraint.column] === constraint.equals,
  )
}

/** A tiny list query: page, perPage, sort (allow-listed), filter[status]. Every bad name is reported. */
export function listRows(
  rows: readonly Row[],
  query: URLSearchParams,
  allowed: { readonly sortable: readonly string[]; readonly filterable: readonly string[] },
): { rows: Row[]; meta: { page: number; perPage: number; total: number } } {
  const issues: IssueInput[] = []
  const page = Number(query.get('page') ?? '1')
  const perPage = Number(query.get('perPage') ?? '15')
  if (!Number.isInteger(page) || page < 1)
    issues.push({ path: ['query', 'page'], code: 'invalid_integer' })
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100)
    issues.push({ path: ['query', 'perPage'], code: 'invalid_integer' })
  const sort = query.get('sort') ?? 'id'
  const sortField = sort.replace(/^-/, '')
  if (!allowed.sortable.includes(sortField))
    issues.push({ path: ['query', 'sort'], code: 'sort_not_allowed' })
  let result = [...rows]
  for (const [key, value] of query) {
    const filter = /^filter\[([a-z_]+)\]$/.exec(key)
    if (filter === null) continue
    const field = filter[1] ?? ''
    if (!allowed.filterable.includes(field)) {
      issues.push({ path: ['query', 'filter', field], code: 'filter_not_allowed' })
      continue
    }
    result = result.filter((row) => String(row[field]) === value)
  }
  if (issues.length > 0) throw new ValidationError(issues)
  result.sort((a, b) => {
    const left = String(a[sortField] ?? '')
    const right = String(b[sortField] ?? '')
    const order = sortField === 'id' ? Number(a['id']) - Number(b['id']) : left.localeCompare(right)
    return sort.startsWith('-') ? -order : order
  })
  return {
    rows: result.slice((page - 1) * perPage, page * perPage),
    meta: { page, perPage, total: result.length },
  }
}
