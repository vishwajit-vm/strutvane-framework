/**
 * The rules that decide what a column *means* to the rest of the app: can a client write it, must
 * it be sent on create, is it returned by the API.
 *
 * Both the type generator and the metadata generator use these, so `NewPost` in TypeScript and the
 * CRUD API's validation can never disagree about which fields are required.
 *
 * @module
 */
import { type ColumnDef, isHiddenColumn, isManagedColumn, isSecretColumn } from '../columns.ts'

/**
 * `true` if a client may set this column through the API's create/update. Keys, the tenant column
 * and framework-managed timestamps are not writable, and neither are secrets (they need a
 * dedicated action, such as "change password", that hashes them).
 *
 * @example
 * isFillable({ name: 'title', kind: 'string', nullable: false }) // true
 * isFillable({ name: 'id', kind: 'id', nullable: false }) // false
 */
export function isFillable(column: ColumnDef): boolean {
  return isWritable(column) && !isSecretColumn(column)
}

/**
 * `true` if app code may write this column through the ORM (`create`, `fill`, `save`): every
 * column except the ones the database or framework fills in. Unlike {@link isFillable} this
 * includes secrets, so a controller can store a password hash.
 *
 * @example
 * isWritable({ name: 'password', kind: 'string', nullable: true }) // true
 * isWritable({ name: 'tenant_id', kind: 'uuid', nullable: false, tenant: true }) // false
 */
export function isWritable(column: ColumnDef): boolean {
  return !isManagedColumn(column)
}

/**
 * `true` if creating a row must provide this column. A column is optional when the database can
 * fill it (nullable or with a default) or the framework can (a slug built from another column).
 *
 * @example
 * isRequiredOnCreate({ name: 'title', kind: 'string', nullable: false }) // true
 * isRequiredOnCreate({ name: 'slug', kind: 'slug', nullable: false, slugFrom: 'title' }) // false
 */
export function isRequiredOnCreate(column: ColumnDef): boolean {
  if (isManagedColumn(column)) return false
  if (column.nullable || 'default' in column) return false
  return column.slugFrom === undefined
}

/**
 * `true` if the JSON API (and `toJSON()`) returns this column: everything except hidden columns
 * and secrets.
 *
 * @example
 * isReturnedByApi({ name: 'password', kind: 'string', nullable: true }) // false
 */
export function isReturnedByApi(column: ColumnDef): boolean {
  return !isHiddenColumn(column)
}
