/**
 * Code generation for `.strutvane/registry.gen.ts`.
 *
 * Determinism rules (tested):
 * - every list is pre-sorted by the registry (code-unit order);
 * - strings are serialised with JSON.stringify (one escaping scheme everywhere);
 * - no timestamps, absolute paths, machine names or random ids;
 * - LF line endings, exactly one trailing newline;
 * - the header carries a sha256 of the body, so tooling can detect hand edits or stale output.
 */
import { createHash } from 'node:crypto'
import { CLI_PACKAGE, CLI_VERSION } from '../version.ts'
import { CONVENTIONS, type EntryKind, OUTPUT_FILE } from './conventions.ts'
import { identifierForFile } from './names.ts'
import type { Registry } from './registry.ts'

/** Who wrote the file, recorded in its header so tooling can tell generated output apart. */
export const GENERATOR_NAME: string = CLI_PACKAGE
/** The CLI version that generated the file. */
export const GENERATOR_VERSION: string = CLI_VERSION

const q = (value: string): string => JSON.stringify(value)

/** Relative import path from the output folder (`.strutvane/`) to a project file. */
function importPath(relPath: string): string {
  const depth = OUTPUT_FILE.split('/').length - 1
  return `${'../'.repeat(depth)}${relPath}`
}

/** Assigns each imported file a unique, deterministic identifier. */
class ImportTable {
  readonly #byFile = new Map<string, string>()
  readonly #used = new Set<string>()

  constructor(files: readonly { kind: EntryKind; file: string }[]) {
    // Sorted by path first, so collision suffixes (_2, _3) are stable.
    const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    for (const { kind, file } of sorted) {
      if (this.#byFile.has(file)) continue
      const convention = CONVENTIONS.find((c) => c.kind === kind)
      const base =
        convention === undefined
          ? `${kind}_file`
          : identifierForFile(kind, file, convention.dir, convention.suffix)
      let id = base
      for (let n = 2; this.#used.has(id); n++) id = `${base}_${n}`
      this.#used.add(id)
      this.#byFile.set(file, id)
    }
  }

  id(file: string): string {
    const id = this.#byFile.get(file)
    if (id === undefined) throw new Error(`internal: no import for ${file}`)
    return id
  }

  statements(): string[] {
    return [...this.#byFile.entries()].map(
      ([file, id]) => `import ${id} from ${q(importPath(file))}`,
    )
  }
}

function union(values: readonly string[]): string {
  return values.length === 0 ? 'never' : values.map(q).join(' | ')
}

/** Render the registry module. */
export function emitRegistry(registry: Registry): string {
  const imports = new ImportTable([
    ...registry.models.map((m) => ({ kind: 'model' as const, file: m.file })),
    ...registry.resources.map((r) => ({ kind: 'resource' as const, file: r.file })),
    ...registry.policies.map((p) => ({ kind: 'policy' as const, file: p.file })),
    ...registry.routes.map((r) => ({ kind: 'route' as const, file: r.file })),
    ...registry.jobs.map((j) => ({ kind: 'job' as const, file: j.file })),
    ...registry.listeners.map((l) => ({ kind: 'listener' as const, file: l.file })),
    ...registry.commands.map((c) => ({ kind: 'command' as const, file: c.file })),
  ])

  const lines: string[] = []
  const push = (...l: string[]): void => {
    lines.push(...l)
  }

  push(...imports.statements(), '')

  push('/** Every model, by name. */', 'export const models = {')
  for (const m of registry.models) push(`  ${q(m.name)}: ${imports.id(m.file)},`)
  push('} as const', 'export type ModelName = keyof typeof models', '')

  push(
    '/** Field names per model (static metadata, read without running app code). */',
    'export const modelFields = {',
  )
  for (const m of registry.models) push(`  ${q(m.name)}: [${m.fields.map(q).join(', ')}],`)
  push('} as const', '')

  push('/** Resources (API behaviour), keyed by model name. */', 'export const resources = {')
  for (const r of registry.resources) push(`  ${q(r.model)}: ${imports.id(r.file)},`)
  push('} as const', '')

  push('/** Policies, keyed by resource key. */', 'export const policies = {')
  for (const p of registry.policies) push(`  ${q(p.resource)}: ${imports.id(p.file)},`)
  push('} as const', '')

  push(
    '/** Every permission the app uses. `can()` only accepts these, so typos fail to compile. */',
    'export const permissions = [',
  )
  for (const p of registry.permissions) push(`  ${q(p)},`)
  push('] as const', 'export type Permission = (typeof permissions)[number]', '')

  push(
    '/** Custom routes (CRUD routes are derived from models at runtime). */',
    'export const routes = [',
  )
  for (const r of registry.routes) {
    const permission = r.permission === undefined ? 'undefined' : q(r.permission)
    push(
      `  { name: ${q(r.name)}, method: ${q(r.method)}, path: ${q(r.path)}, permission: ${permission}, file: ${q(r.file)} },`,
    )
  }
  push('] as const', `export type RouteName = ${union(registry.routes.map((r) => r.name))}`, '')

  const routeFiles = [...new Set(registry.routes.map((r) => r.file))]
  push(
    '/** Route modules (each default-exports its route list). */',
    'export const routeModules = [',
  )
  for (const file of routeFiles) push(`  ${imports.id(file)},`)
  push('] as const', '')

  push('/** Queue jobs, by name. */', 'export const jobs = {')
  for (const j of registry.jobs) push(`  ${q(j.name)}: ${imports.id(j.file)},`)
  push('} as const', 'export type JobName = keyof typeof jobs', '')

  push('/** Event listeners (several may handle the same event). */', 'export const listeners = [')
  for (const l of registry.listeners)
    push(`  { event: ${q(l.name)}, listener: ${imports.id(l.file)} },`)
  push('] as const', '')

  push('/** CLI commands, by name. */', 'export const commands = {')
  for (const c of registry.commands) push(`  ${q(c.name)}: ${imports.id(c.file)},`)
  push('} as const', '')

  push(
    '/** UI pages: URL → lazily loaded module (code-split per page). */',
    'export const pages = [',
  )
  for (const p of registry.pages)
    push(
      `  { path: ${q(p.route)}, file: ${q(p.file)}, load: () => import(${q(importPath(p.file))}) },`,
    )
  push('] as const', `export type PagePath = ${union(registry.pages.map((p) => p.route))}`)

  const body = `${lines.join('\n')}\n`
  const hash = createHash('sha256').update(body).digest('hex')
  const header = [
    `// @generated by ${GENERATOR_NAME} ${GENERATOR_VERSION}. DO NOT EDIT: run \`sv registry:build\` instead.`,
    `// content-hash: sha256-${hash}`,
    '',
  ].join('\n')
  return `${header}${body}`
}

/** Verify that a generated file's body still matches its header hash (detects hand edits). */
export function verifyContentHash(source: string): boolean {
  const match = /^\/\/ @generated[^\n]*\n\/\/ content-hash: sha256-([0-9a-f]{64})\n/.exec(source)
  if (match === null || match[1] === undefined) return false
  const body = source.slice(match[0].length)
  return createHash('sha256').update(body).digest('hex') === match[1]
}
