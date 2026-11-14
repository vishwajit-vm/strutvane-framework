/**
 * Edits a project's `package.json` dependencies for installers.
 *
 * Rules:
 * - **Never downgrades or replaces** a dependency the project already has: an existing entry (in
 *   any dependency field) is kept and reported. The developer's choice wins.
 * - **Refuses local-only specs** (`link:`, `file:`, `workspace:`, paths). They work on one machine
 *   and break everyone else's install (ADR-0016).
 * - Keys inside each dependency field are sorted, matching what npm/pnpm do, so diffs stay small.
 * - Indentation, line endings and the final newline of the original file are preserved.
 *
 * @module
 */
import type { InstallDeps } from '../contracts/index.ts'
import { DevkitError, describeError } from './errors.ts'
import { shapeOf } from './text.ts'

/** What happened to each requested dependency. */
export interface DepsAddResult {
  readonly added: readonly string[]
  /** Already present (possibly with a different spec); left untouched. */
  readonly kept: readonly string[]
}

/** The minimal file access the editor needs (a {@link StagedFs} fits). */
export interface DepsEditorFs {
  read(path: string): Promise<string>
  write(path: string, content: string, options?: { readonly overwrite?: boolean }): Promise<void>
}

/**
 * The contracts' `InstallDeps`, plus a reporting variant and removal for uninstallers.
 *
 * `add` keeps the contract's `Promise<void>` signature so a devkit editor can be passed anywhere an
 * `InstallDeps` is expected; {@link DepsEditor.ensure} does the same work and says what it did.
 */
export interface DepsEditor extends InstallDeps {
  /** Same as `add`, but reports which dependencies were added and which already existed. */
  ensure(
    deps: Readonly<Record<string, string>>,
    options?: { readonly dev?: boolean },
  ): Promise<DepsAddResult>
  /** Remove dependencies from every dependency field. Missing names are ignored. */
  remove(names: readonly string[]): Promise<void>
}

const FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const
const LOCAL_SPEC = /^(link:|file:|workspace:|portal:|\.{1,2}\/|\/|[A-Za-z]:[\\/])/
const NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

type PackageJson = Record<string, unknown>

/** Detect the indentation unit of a JSON document (tabs or N spaces; default 2 spaces). */
export function detectIndent(text: string): string {
  const m = /^([ \t]+)"/m.exec(text)
  return m?.[1] ?? '  '
}

function parse(text: string): PackageJson {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    throw new DevkitError(
      'INVALID_PACKAGE_JSON',
      `package.json is not valid JSON: ${describeError(error)}`,
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DevkitError('INVALID_PACKAGE_JSON', 'package.json must contain a JSON object')
  }
  return value as PackageJson
}

function field(pkg: PackageJson, name: string): Record<string, string> {
  const value = pkg[name]
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DevkitError('INVALID_PACKAGE_JSON', `package.json "${name}" must be an object`)
  }
  return value as Record<string, string>
}

function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function serialise(pkg: PackageJson, original: string): string {
  const shape = shapeOf(original)
  const json = JSON.stringify(pkg, null, detectIndent(original))
  const body = shape.eol === '\r\n' ? json.replace(/\n/g, '\r\n') : json
  return (shape.bom ? '﻿' : '') + body + (shape.finalNewline || original === '' ? shape.eol : '')
}

/** Create an editor for `package.json` (default path) in a project. */
export function createDepsEditor(
  fs: DepsEditorFs,
  options: { readonly path?: string } = {},
): DepsEditor {
  const path = options.path ?? 'package.json'
  const editor: DepsEditor = {
    async add(deps, addOptions) {
      await editor.ensure(deps, addOptions)
    },

    async ensure(deps, addOptions = {}) {
      for (const [name, spec] of Object.entries(deps)) {
        if (!NAME.test(name)) {
          throw new DevkitError('INVALID_PACKAGE_JSON', `"${name}" is not a valid npm package name`)
        }
        if (typeof spec !== 'string' || spec.trim() === '') {
          throw new DevkitError(
            'INVALID_PACKAGE_JSON',
            `version for "${name}" must be a non-empty string`,
          )
        }
        if (LOCAL_SPEC.test(spec)) {
          throw new DevkitError(
            'LOCAL_DEPENDENCY_SPEC',
            `"${name}": "${spec}" only works on one machine; use a published version (ADR-0016)`,
          )
        }
      }
      const original = await fs.read(path)
      const pkg = parse(original)
      const target = addOptions.dev === true ? 'devDependencies' : 'dependencies'
      const present = new Set(FIELDS.flatMap((f) => Object.keys(field(pkg, f))))
      const added: string[] = []
      const kept: string[] = []
      const next = { ...field(pkg, target) }
      for (const [name, spec] of Object.entries(deps)) {
        if (present.has(name)) kept.push(name)
        else {
          next[name] = spec
          added.push(name)
        }
      }
      if (added.length > 0) {
        pkg[target] = sorted(next)
        await fs.write(path, serialise(pkg, original), { overwrite: true })
      }
      return { added, kept }
    },

    async remove(names) {
      const original = await fs.read(path)
      const pkg = parse(original)
      let changed = false
      for (const f of FIELDS) {
        if (pkg[f] === undefined) continue
        const record = { ...field(pkg, f) }
        for (const name of names) {
          if (name in record) {
            delete record[name]
            changed = true
          }
        }
        pkg[f] = record
      }
      if (changed) await fs.write(path, serialise(pkg, original), { overwrite: true })
    },
  }
  return editor
}
