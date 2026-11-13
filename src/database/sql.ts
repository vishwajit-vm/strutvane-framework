/**
 * A minimal, safe SQL builder: identifiers are always quoted, values are always bound parameters.
 *
 * Fragments are kept as `{ text, params }` with `?` placeholders and numbered for Postgres (`$1`)
 * only at the end, so fragments compose without renumbering bugs.
 *
 * @module
 */
import type { Dialect } from './types.ts'

/** A composable SQL fragment. `text` uses `?` placeholders. */
export interface SqlFragment {
  readonly text: string
  readonly params: readonly unknown[]
}

/** Quote an identifier (table or column). Rejects anything that isn't a plain identifier. */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name))
    throw new TypeError(`Invalid SQL identifier "${name}"`)
  return `"${name}"`
}

/** A fragment from text and parameters. */
export function frag(text: string, params: readonly unknown[] = []): SqlFragment {
  const count = placeholders(text)
  if (count !== params.length)
    throw new Error(`SQL fragment has ${count} placeholders but ${params.length} params`)
  return { text, params }
}

/** Count `?` placeholders outside single-quoted literals (the same rule `render` uses). */
function placeholders(text: string): number {
  let n = 0
  let inString = false
  for (const ch of text) {
    if (ch === "'") inString = !inString
    else if (ch === '?' && !inString) n++
  }
  return n
}

/** Join fragments with a separator. */
export function join(fragments: readonly SqlFragment[], separator: string): SqlFragment {
  return {
    text: fragments.map((f) => f.text).join(separator),
    params: fragments.flatMap((f) => f.params),
  }
}

/**
 * Turn a fragment into the dialect's final SQL: `?` → `$1, $2…` on Postgres. Question marks inside
 * single-quoted literals are left untouched.
 */
export function render(
  fragment: SqlFragment,
  dialect: Dialect,
): { sql: string; params: unknown[] } {
  if (dialect === 'sqlite') return { sql: fragment.text, params: [...fragment.params] }
  let n = 0
  let inString = false
  let out = ''
  for (const ch of fragment.text) {
    if (ch === "'") inString = !inString
    if (ch === '?' && !inString) {
      n++
      out += `$${n}`
    } else out += ch
  }
  return { sql: out, params: [...fragment.params] }
}
