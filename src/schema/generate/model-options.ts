/**
 * What the app's models say about mass assignment, read from `app/models/*.ts` **without running
 * them**: `Model('users', { fillable, hidden, allowSensitive })`.
 *
 * **Why:** the model is the only place that says which columns a request may set (Laravel's
 * `$fillable`). Resource metadata derived from the migration alone made every writable column
 * fillable, so `users.email_verified_at` came out fillable although `User` allows only `name` and
 * `email`: a generated CRUD API trusting it would let a user verify their own email (found by the
 * skeleton, 2026-11-18). The metadata generator now takes these lists from the model.
 *
 * **Why parse instead of import:** `node strut migrate` and `sync` regenerate metadata on every run,
 * and importing app code there would execute it (and need the database). The model options are
 * plain literals by convention, so the parser reads them exactly.
 *
 * **Fail closed:** a list that isn't an array of string literals (a variable, a spread, a call) is
 * reported as a problem, and that model's table gets *no* fillable fields rather than a guess.
 *
 * @module
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseSync } from 'oxc-parser'

/**
 * One model's mass-assignment settings. `fillable: undefined` means the model declares none, so
 * `create()`/`fill()` refuse every column (the ORM's rule).
 *
 * @example
 * const user: ModelOptions = { model: 'User', file: 'app/models/user.ts', fillable: ['name', 'email'], hidden: ['password'], allowSensitive: [] }
 */
export interface ModelOptions {
  readonly model: string
  /** The file, relative to the project root, with forward slashes. */
  readonly file: string
  readonly fillable: readonly string[] | undefined
  readonly hidden: readonly string[]
  readonly allowSensitive: readonly string[]
}

/** The models found, by table, and every problem that made one fail closed. */
export interface AppModels {
  readonly tables: ReadonlyMap<string, ModelOptions>
  readonly problems: readonly string[]
}

const MAX_FILES = 2_000
const MAX_DEPTH = 8
const KEYS = ['fillable', 'hidden', 'allowSensitive'] as const

type Node = { readonly type: string } & Readonly<Record<string, unknown>>

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  )
}

/**
 * Read every model under `<root>/app/models` (recursively; symlinks are not followed). Two models
 * for one table merge to the stricter settings: only columns both allow are fillable, and columns
 * either hides are hidden.
 *
 * @example
 * readAppModels('/srv/blog').tables.get('users')?.fillable // ['name', 'email']
 */
export function readAppModels(root: string): AppModels {
  const dir = join(root, 'app', 'models')
  const problems: string[] = []
  const tables = new Map<string, ModelOptions>()
  if (!existsSync(dir)) return { tables, problems }
  for (const file of modelFiles(dir, problems)) {
    const label = relative(root, file).replaceAll('\\', '/')
    for (const found of modelsIn(label, readFileSync(file, 'utf8'), problems)) {
      const existing = tables.get(found.table)
      tables.set(
        found.table,
        existing === undefined ? found.options : stricter(existing, found.options),
      )
    }
  }
  return { tables, problems }
}

function modelFiles(dir: string, problems: string[]): string[] {
  const files: string[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(path, depth + 1)
      else if (
        /\.(c|m)?ts$/.test(entry) &&
        !entry.endsWith('.d.ts') &&
        !/\.test(-d)?\.ts$/.test(entry)
      ) {
        if (files.length >= MAX_FILES) {
          problems.push(`app/models has more than ${MAX_FILES} files; the rest were not read.`)
          return
        }
        files.push(path)
      }
    }
  }
  walk(dir, 0)
  return files
}

/** Every `Model('<table>', { … })` call in one file, with the class that extends it when named. */
function modelsIn(
  label: string,
  source: string,
  problems: string[],
): { table: string; options: ModelOptions }[] {
  const parsed = parseSync(label, source, { sourceType: 'module', lang: 'ts' })
  if (parsed.errors.length > 0) {
    problems.push(`${label} could not be parsed, so its model settings were not read.`)
    return []
  }
  const found: { table: string; options: ModelOptions }[] = []
  const visit = (node: Node, owner: string | undefined): void => {
    // `class User extends Model('users', …)`: remember the class name for messages.
    const className =
      node.type === 'ClassDeclaration' || node.type === 'ClassExpression'
        ? identifierName(node['id'])
        : undefined
    if (node.type === 'CallExpression' && identifierName(node['callee']) === 'Model') {
      const model = modelCall(label, node, owner ?? 'model', problems)
      if (model !== undefined) found.push(model)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, className ?? owner)
      } else if (isNode(value)) visit(value, className ?? owner)
    }
  }
  visit(parsed.program as unknown as Node, undefined)
  return found
}

function modelCall(
  label: string,
  call: Node,
  model: string,
  problems: string[],
): { table: string; options: ModelOptions } | undefined {
  const args = Array.isArray(call['arguments']) ? call['arguments'].filter(isNode) : []
  const [tableArg, optionsArg] = args
  const table = tableArg !== undefined ? stringLiteral(tableArg) : undefined
  if (table === undefined) {
    problems.push(`${label}: ${model} names its table with something other than a string literal.`)
    return undefined
  }
  const lists: Record<(typeof KEYS)[number], readonly string[] | undefined> = {
    fillable: undefined,
    hidden: undefined,
    allowSensitive: undefined,
  }
  let unreadable = false
  const options = optionsArg === undefined ? undefined : unwrap(optionsArg)
  if (options !== undefined && options.type !== 'ObjectExpression') unreadable = true
  for (const property of Array.isArray(options?.['properties']) ? options['properties'] : []) {
    if (!isNode(property)) continue
    if (property.type !== 'Property') {
      unreadable = true // a spread: the lists could come from anywhere
      continue
    }
    const key = propertyKey(property)
    if (key === undefined || !(KEYS as readonly string[]).includes(key)) continue
    const value = isNode(property['value']) ? stringArray(unwrap(property['value'])) : undefined
    if (value === undefined) unreadable = true
    else lists[key as (typeof KEYS)[number]] = value
  }
  if (unreadable)
    problems.push(
      `${label}: ${model}'s options are not plain literals (write fillable, hidden and allowSensitive as arrays of strings), so no field of "${table}" is fillable in .strutvane/resources.json.`,
    )
  return {
    table,
    options: {
      model,
      file: label,
      // Unreadable: fail closed, as if nothing were fillable.
      fillable: unreadable ? [] : lists.fillable,
      hidden: lists.hidden ?? [],
      allowSensitive: unreadable ? [] : (lists.allowSensitive ?? []),
    },
  }
}

function stricter(a: ModelOptions, b: ModelOptions): ModelOptions {
  const fillable =
    a.fillable === undefined || b.fillable === undefined
      ? undefined
      : a.fillable.filter((column) => b.fillable?.includes(column))
  return {
    model: `${a.model} and ${b.model}`,
    file: `${a.file}, ${b.file}`,
    fillable,
    hidden: [...new Set([...a.hidden, ...b.hidden])],
    allowSensitive: a.allowSensitive.filter((column) => b.allowSensitive.includes(column)),
  }
}

/** Strip `( … )`, `as const`, `satisfies …`: they don't change the value. */
function unwrap(node: Node): Node {
  let current = node
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSNonNullExpression'
  ) {
    const inner = current['expression']
    if (!isNode(inner)) break
    current = inner
  }
  return current
}

function identifierName(value: unknown): string | undefined {
  if (!isNode(value) || value.type !== 'Identifier') return undefined
  const name = value['name']
  return typeof name === 'string' ? name : undefined
}

function stringLiteral(node: Node): string | undefined {
  const inner = unwrap(node)
  if (inner.type === 'Literal' && typeof inner['value'] === 'string') return inner['value']
  if (inner.type === 'TemplateLiteral') {
    const expressions = inner['expressions']
    const quasis = inner['quasis']
    if (Array.isArray(expressions) && expressions.length === 0 && Array.isArray(quasis)) {
      const first = quasis[0]
      const cooked = isNode(first) ? Reflect.get(Object(first['value']), 'cooked') : undefined
      if (typeof cooked === 'string') return cooked
    }
  }
  return undefined
}

function stringArray(node: Node): string[] | undefined {
  if (node.type !== 'ArrayExpression' || !Array.isArray(node['elements'])) return undefined
  const values: string[] = []
  for (const element of node['elements']) {
    const value = isNode(element) ? stringLiteral(element) : undefined
    if (value === undefined) return undefined
    values.push(value)
  }
  return values
}

function propertyKey(property: Node): string | undefined {
  const key = property['key']
  if (!isNode(key)) return undefined
  if (property['computed'] === true) return stringLiteral(key)
  return identifierName(key) ?? stringLiteral(key)
}
