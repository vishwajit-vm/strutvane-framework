/**
 * Every error the ORM throws on purpose.
 *
 * Each one carries a stable `code` (the product maps these to RFC 9457 problems and message
 * catalogs, RFC-0003) and a message written for the developer who will read it in a terminal:
 * what went wrong, then how to fix it.
 */

/**
 * The base class: an ORM error with a stable, machine-readable code.
 *
 * @example
 * try { await Post.findOrFail(9) } catch (error) { if (error instanceof OrmError) console.log(error.code) }
 */
export class OrmError extends Error {
  override readonly name: string = 'OrmError'
  /** Stable identifier, safe to switch on (messages may be reworded, codes never are). */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * A query that had to find a row found none (`findOrFail`, `firstOrFail`, saving a deleted row).
 * The product turns it into a 404, never a 403, so it does not reveal that the row exists.
 *
 * @example
 * throw new ModelNotFoundError('posts', 42)
 */
export class ModelNotFoundError extends OrmError {
  override readonly name = 'ModelNotFoundError'

  constructor(table: string, key?: unknown) {
    const which = key === undefined ? 'matching your query' : `with key ${JSON.stringify(key)}`
    super(
      'model_not_found',
      `No row in "${table}" ${which}. It may not exist, may be soft-deleted, or may belong to another tenant.`,
    )
  }
}

/**
 * Someone tried to mass-assign a field the model does not allow (`fillable`), or a field that
 * does not exist. Strutvane throws instead of silently dropping it: a silently ignored field is
 * how "I set is_admin and nothing happened" bugs and mass-assignment holes hide.
 *
 * @example
 * throw new MassAssignmentError('users', 'is_admin', 'not-fillable')
 */
export class MassAssignmentError extends OrmError {
  override readonly name = 'MassAssignmentError'
  /** The offending field. */
  readonly field: string

  constructor(
    table: string,
    field: string,
    reason: 'not-fillable' | 'unknown' | 'system',
    suggestion?: string,
  ) {
    super('mass_assignment', massAssignmentMessage(table, field, reason, suggestion))
    this.field = field
  }
}

function massAssignmentMessage(
  table: string,
  field: string,
  reason: 'not-fillable' | 'unknown' | 'system',
  suggestion?: string,
): string {
  if (reason === 'unknown') {
    const hint = suggestion === undefined ? '' : ` Did you mean "${suggestion}"?`
    return `"${table}" has no column "${field}".${hint} Columns come from your migrations: add one with a new migration, then run \`node strut migrate\`.`
  }
  if (reason === 'system') {
    return `"${field}" on "${table}" is managed by Strutvane (keys, timestamps, soft deletes, tenant) and can't be mass-assigned. Remove it from the input.`
  }
  return (
    `"${field}" can't be mass-assigned on "${table}". If users may set it, add it to \`fillable\` in ` +
    `Model('${table}', { fillable: [...] }). If your own code sets it, assign it directly (model.${field} = value) or use forceCreate().`
  )
}

/**
 * A tenant-scoped table was used outside a tenant context. Strutvane fails closed: no tenant
 * means no rows, never all rows.
 *
 * @example
 * throw new TenantRequiredError('projects')
 */
export class TenantRequiredError extends OrmError {
  override readonly name = 'TenantRequiredError'

  constructor(table: string, source: 'query' | 'raw' = 'query') {
    super(
      'tenant_required',
      `"${table}" is tenant-scoped, but no tenant is active. Wrap the work in runWithTenant(tenantId, () => …) ` +
        '(the HTTP layer does this for you per request). ' +
        (source === 'raw'
          ? 'Hand-written SQL that must see every tenant (a report, a maintenance job) uses unsafeRaw(reason, sql`…`) or runs inside runWithoutTenant(reason, () => …); both are audited, and console commands, migrations and seeders already run that way.'
          : 'Deliberate cross-tenant jobs use .unsafeWithoutTenancy(reason), which is audited.'),
    )
  }
}

/**
 * Two different tenants met in one transaction or one write. Always a bug; never silently
 * resolved.
 *
 * @example
 * throw new TenantMismatchError('projects', 'tenant_id differs from the active tenant')
 */
export class TenantMismatchError extends OrmError {
  override readonly name = 'TenantMismatchError'

  constructor(table: string, detail: string) {
    super(
      'tenant_mismatch',
      `Refusing to touch "${table}": ${detail}. One unit of work may only ever see one tenant.`,
    )
  }
}

/**
 * The developer used the ORM wrongly in a way we can name precisely (unknown relation, a
 * cursor on a nullable column, a page size out of range…). The message says how to fix it.
 *
 * @example
 * throw new OrmUsageError('unknown_relation', 'Post has no relation "autor".')
 */
export class OrmUsageError extends OrmError {
  override readonly name = 'OrmUsageError'
}

/**
 * Relations were loaded one model at a time inside a loop (the N+1 problem), while
 * `preventLazyLoading` is on (the default outside production).
 *
 * @example
 * throw new LazyLoadingError('posts', 'author')
 */
export class LazyLoadingError extends OrmError {
  override readonly name = 'LazyLoadingError'

  constructor(table: string, relation: string) {
    super(
      'lazy_loading',
      `You're loading "${relation}" one "${table}" row at a time (an N+1 query). ` +
        `Load it for the whole list instead: Model.query().with('${relation}'), or await loadMany(models, '${relation}').`,
    )
  }
}

/**
 * A value does not fit its column (an enum value that is not allowed, a malformed date…).
 *
 * @example
 * throw new CastError('posts', 'status', '"archived" is not one of draft, published')
 */
export class CastError extends OrmError {
  override readonly name = 'CastError'

  constructor(table: string, column: string, detail: string) {
    super('invalid_value', `Can't store that value in "${table}.${column}": ${detail}.`)
  }
}
