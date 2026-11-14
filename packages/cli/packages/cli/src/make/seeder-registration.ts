/**
 * Registering a model's seeder in `database/seeders/database.seeder.ts`, the only seeder
 * `sv db:seed` runs without `--class`.
 *
 * **Why.** `sv make:model` writes `database/seeders/<model>.seeder.ts`, but a seeder that is not
 * called from the database seeder never runs: `sv db:seed` reported success and seeded nothing.
 * So `make:model` (and `make:seeder --model`) also add the import and an `await call(XSeeder)`
 * line, in dependency order: after the seeders of the models it belongs to (their rows must exist
 * before rows that point to them), and before the seeders of models that belong to it.
 *
 * **How.** A text patch with strict anchors, not an AST rewrite: the file is user code, so it is
 * changed only when every anchor matches the shapes `create-strutvane` generates (the canonical
 * string form, or the older `defineSeeder({ async run() {…} })` starter shape, which is migrated).
 * Anything else is left untouched and the exact lines to add are returned for the user. The
 * patch is idempotent (a registered seeder is a no-op), keeps Biome's import order (packages, then
 * relative paths in Biome's natural order) so the project's `biome check` still passes, and keeps
 * the file's line endings.
 *
 * @module
 */

/** Where the database seeder lives, relative to the project root. */
export const DATABASE_SEEDER_PATH = 'database/seeders/database.seeder.ts'

const CALLBACK_COMMENT =
  '  // `sv make:model` adds `await call(…)` lines here, parents before children.'
const IMPORT_DEFINE = "import { defineSeeder } from '@strutvane/framework/database'"

/** The database seeder `create-strutvane` generates (without the optional auth note). */
export const CANONICAL_DATABASE_SEEDER: string = [
  '/**',
  " * Seeds the database (`pnpm sv db:seed`). `sv make:model` registers each new model's seeder here,",
  ' * after the seeders of the models it belongs to.',
  ' */',
  IMPORT_DEFINE,
  '',
  "export default defineSeeder('DatabaseSeeder', async () => {",
  CALLBACK_COMMENT,
  '})',
  '',
].join('\n')

/** What to register. */
export interface SeederRegistration {
  /** The seeder's default-export name, e.g. `InvoiceSeeder`. */
  readonly seeder: string
  /** Its import path relative to `database/seeders/`, e.g. `./invoice.seeder.ts`. */
  readonly importPath: string
  /** Seeders that must run first (of the models this one belongs to). */
  readonly after: readonly string[]
  /** Seeders that must run later (of the models that belong to this one). */
  readonly before: readonly string[]
}

/** The outcome of {@link registerSeeder}. */
export type RegistrationResult =
  | {
      /** `registered`: the content changed; `unchanged`: already registered. */
      readonly status: 'registered' | 'unchanged'
      readonly content: string
      /** The file did not exist and is created in canonical shape. */
      readonly created: boolean
      /** The old starter shape was migrated to the canonical one. */
      readonly migrated: boolean
      /** Entries of `after` that are not registered (their rows will not exist first). */
      readonly missingAfter: readonly string[]
    }
  | {
      /** The file does not match the recognised shapes: it is not edited. */
      readonly status: 'unrecognised'
      /** The lines the user should add by hand. */
      readonly manual: readonly string[]
    }

const SEEDER_NAME = /^[A-Z][A-Za-z0-9]*$/
const IMPORT_PATH = /^\.\/[a-z0-9][a-z0-9.-]*\.seeder\.ts$/

/** The lines a user adds by hand when the file cannot be patched. */
function manualLines(r: SeederRegistration): string[] {
  return [
    `import ${r.seeder} from '${r.importPath}'`,
    `await call(${r.seeder})   (inside the defineSeeder callback, whose parameter is ({ call }))`,
  ]
}

/**
 * The exact body of the starter's previous `database.seeder.ts`. Only this shape is migrated; a
 * file whose body was edited is "unrecognised" and left alone.
 */
const OLD_BODY = [
  'export default defineSeeder({',
  '  async run() {',
  '    // await call(InvoiceSeeder)',
  '  },',
  '})',
]
const OLD_DOC = /^( \* Seeds the database \(`[^`]*`\)\.) Call other seeders from here, in order\.$/

/** Migrate the old starter shape (`defineSeeder({ async run() {…} })`) to the canonical one. */
function migrateOldShape(lines: string[]): string[] | undefined {
  const start = lines.indexOf(OLD_BODY[0] ?? '')
  if (start < 0) return undefined
  if (!OLD_BODY.every((line, i) => lines[start + i] === line)) return undefined
  if (lines.slice(start + OLD_BODY.length).some((line) => line.trim() !== '')) return undefined
  const out = [
    ...lines.slice(0, start),
    "export default defineSeeder('DatabaseSeeder', async () => {",
    CALLBACK_COMMENT,
    '})',
    ...lines.slice(start + OLD_BODY.length),
  ]
  const doc = out.findIndex((line) => OLD_DOC.test(line))
  if (doc >= 0) {
    const match = OLD_DOC.exec(out[doc] ?? '')
    out.splice(
      doc,
      1,
      `${match?.[1] ?? ''} \`sv make:model\` registers each new model's seeder here,`,
      ' * after the seeders of the models it belongs to.',
    )
  }
  return out
}

/**
 * Biome's natural order for import sources (`organizeImports`), as far as seeder paths need it:
 * `/` and `.` sort first, then `-`, then digit runs by value, then letters. Checked against Biome
 * 2.6: `./a.seeder.ts` < `./a-1…` < `./a-b…` < `./a-b-c…` < `./a1…` < `./a10…` < `./ab…`.
 */
export function compareImportSources(a: string, b: string): number {
  const tokens = (s: string): [number, number][] => {
    const out: [number, number][] = []
    for (const m of s.matchAll(/\d+|./gsu)) {
      const t = m[0]
      if (/^\d+$/.test(t)) out.push([3, Number(t)])
      else if (t === '/') out.push([0, 0])
      else if (t === '.') out.push([1, 0])
      else if (t === '-') out.push([2, 0])
      else out.push([4, t.codePointAt(0) ?? 0])
    }
    return out
  }
  const x = tokens(a)
  const y = tokens(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [xr = 0, xv = 0] = x[i] ?? []
    const [yr = 0, yv = 0] = y[i] ?? []
    if (xr !== yr) return xr - yr
    if (xv !== yv) return xv - yv
  }
  return x.length - y.length
}

const IMPORT_LINE = /^import (?:type )?(.+) from '([^']+)'$/
const OPENER =
  /^export default defineSeeder\('DatabaseSeeder', async \((\{ ?([A-Za-z0-9_, ]*?) ?\})?\) => \{$/
const CALL_LINE = /^ {2}await call\(([A-Za-z0-9_]+)\)$/

/**
 * Register `r` in the database seeder's content (`undefined` when the file does not exist yet).
 * Pure: the caller writes the result.
 */
export function registerSeeder(
  content: string | undefined,
  r: SeederRegistration,
): RegistrationResult {
  if (!SEEDER_NAME.test(r.seeder) || !IMPORT_PATH.test(r.importPath)) {
    return { status: 'unrecognised', manual: manualLines(r) }
  }
  const created = content === undefined
  const source = content ?? CANONICAL_DATABASE_SEEDER
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  let lines = source.replace(/^﻿/, '').split(/\r?\n/)
  let migrated = false
  if (!lines.some((line) => OPENER.test(line))) {
    const next = migrateOldShape(lines)
    if (next === undefined) return { status: 'unrecognised', manual: manualLines(r) }
    lines = next
    migrated = true
  }

  // Anchors: exactly one opener, closed by the first `})` at column 0 after it.
  const openers = lines.flatMap((line, i) => (OPENER.test(line) ? [i] : []))
  const open = openers[0]
  if (open === undefined || openers.length > 1) {
    return { status: 'unrecognised', manual: manualLines(r) }
  }
  const close = lines.indexOf('})', open + 1)
  if (close < 0 || lines.slice(close + 1).some((line) => line.trim() !== '')) {
    return { status: 'unrecognised', manual: manualLines(r) }
  }

  // Imports: single-line statements only, all before the opener.
  const imports = lines.flatMap((line, i) => {
    const m = IMPORT_LINE.exec(line)
    return m === null ? [] : [{ index: i, binding: m[1] ?? '', source: m[2] ?? '' }]
  })
  if (
    imports.length === 0 ||
    imports.some((imp) => imp.index > open) ||
    lines.slice(0, open).some((line) => /^import\b/.test(line) && !IMPORT_LINE.test(line))
  ) {
    return { status: 'unrecognised', manual: manualLines(r) }
  }
  const sameSource = imports.find((imp) => imp.source === r.importPath)
  const sameBinding = imports.find((imp) => imp.binding === r.seeder)
  if (
    (sameSource !== undefined && sameSource.binding !== r.seeder) ||
    (sameBinding !== undefined && sameBinding.source !== r.importPath)
  ) {
    return { status: 'unrecognised', manual: manualLines(r) }
  }

  const callIndex = (name: string): number =>
    lines.findIndex((line, i) => i > open && i < close && CALL_LINE.exec(line)?.[1] === name)
  const missingAfter = r.after.filter((name) => name !== r.seeder && callIndex(name) < 0)
  if (sameSource !== undefined && callIndex(r.seeder) >= 0) {
    const content = lines.join(eol)
    return {
      status: migrated ? 'registered' : 'unchanged',
      content,
      created,
      migrated,
      missingAfter,
    }
  }

  // 1. The call: after the last parent, else before the first child, else at the end.
  if (callIndex(r.seeder) < 0) {
    const parents = r.after.map(callIndex).filter((i) => i >= 0)
    const children = r.before.map(callIndex).filter((i) => i >= 0)
    const at =
      parents.length > 0
        ? Math.max(...parents) + 1
        : children.length > 0
          ? Math.min(...children)
          : close
    lines.splice(at, 0, `  await call(${r.seeder})`)
  }

  // 2. The callback must receive `call`.
  const opener = OPENER.exec(lines[open] ?? '')
  const params = (opener?.[2] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
  if (!params.includes('call')) {
    lines[open] =
      `export default defineSeeder('DatabaseSeeder', async ({ ${[...params, 'call'].join(', ')} }) => {`
  }

  // 3. The import, in Biome's order: packages first, then relative paths.
  if (sameSource === undefined) {
    const line = `import ${r.seeder} from '${r.importPath}'`
    const relative = imports.filter((imp) => imp.source.startsWith('.'))
    const next = relative.find((imp) => compareImportSources(r.importPath, imp.source) < 0)
    const last = imports[imports.length - 1]
    const at = next !== undefined ? next.index : (last?.index ?? 0) + 1
    lines.splice(at, 0, line)
  }

  return {
    status: 'registered',
    content: lines.join(eol),
    created,
    migrated,
    missingAfter,
  }
}
