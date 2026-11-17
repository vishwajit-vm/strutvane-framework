/**
 * The statement guard: one function every SQL statement passes through before it is rendered.
 *
 * The connection knows nothing about tenancy; the ORM installs a guard here (see
 * `orm/tenant-scope.ts`) that refuses unchecked SQL touching tenant tables. Keeping the hook in
 * the db layer means even `connection.run(sql\`…\`)` written by hand cannot skip it.
 */
import type { SqlFragment } from '../sql/fragment.ts'

/** A check that throws when a statement must not run. */
export type StatementGuard = (fragment: SqlFragment) => void

let guard: StatementGuard | undefined

/**
 * Install the guard (the ORM does this when it loads).
 *
 * @example
 * setStatementGuard((fragment) => { … })
 */
export function setStatementGuard(next: StatementGuard): void {
  guard = next
}

/**
 * Run the guard on a statement, if one is installed.
 *
 * @example
 * guardStatement(fragment) // throws when the statement is not allowed
 */
export function guardStatement(fragment: SqlFragment): void {
  guard?.(fragment)
}
