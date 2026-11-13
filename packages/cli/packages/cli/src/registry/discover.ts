/**
 * Discovery: find every convention file under a project root.
 *
 * Uses `fs.readdirSync(..., { recursive })` (Node 20+) instead of a glob library: the conventions
 * are a fixed table of `directory + suffix`, so a glob engine would add a dependency and its own
 * ordering/escaping rules without adding power.
 *
 * Output is project-relative POSIX paths sorted by UTF-16 code units, so the result is identical
 * whatever order the OS returns directory entries in.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONVENTIONS, type Convention, type EntryKind } from './conventions.ts'
import { type Diagnostic, diagnosticForFile } from './errors.ts'
import { compareCodeUnits, relativePosix, toPosix } from './paths.ts'

export interface DiscoveredFile {
  readonly kind: EntryKind
  /** Project-relative POSIX path, e.g. `app/models/invoice.model.ts`. */
  readonly relPath: string
  readonly absPath: string
  readonly convention: Convention
}

export interface DiscoveryResult {
  readonly files: readonly DiscoveredFile[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Files that live in convention folders but are not app entries. */
function isIgnoredName(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('_') ||
    name.endsWith('.d.ts') ||
    /\.(test|spec)\.tsx?$/.test(name)
  )
}

export function discover(root: string): DiscoveryResult {
  const files: DiscoveredFile[] = []
  const diagnostics: Diagnostic[] = []

  for (const convention of CONVENTIONS) {
    const dir = join(root, ...convention.dir.split('/'))
    if (!existsSync(dir)) continue
    const entries = readdirSync(dir, { recursive: convention.recursive, withFileTypes: true })
    for (const entry of entries) {
      // Only regular files. Symlinks are skipped on purpose: following them could escape the
      // project or create cycles, and their targets are not watched.
      if (!entry.isFile()) continue
      const name = entry.name
      if (isIgnoredName(name)) continue
      const absPath = join(entry.parentPath, name)
      const relPath = relativePosix(root, absPath)
      if (!name.endsWith(convention.suffix)) {
        if (name.toLowerCase().endsWith(convention.suffix.toLowerCase())) {
          diagnostics.push(
            diagnosticForFile(
              'SUSPICIOUS_FILE_NAME',
              'warning',
              relPath,
              `File is ignored because its suffix is not exactly "${convention.suffix}".`,
              `Rename it to end with "${convention.suffix}" (suffixes are case-sensitive so the result is the same on every OS).`,
            ),
          )
        }
        continue
      }
      files.push({ kind: convention.kind, relPath, absPath, convention })
    }
  }

  files.sort((a, b) => compareCodeUnits(a.relPath, b.relPath))
  diagnostics.push(...detectCaseConflicts(files.map((f) => f.relPath)))
  return { files, diagnostics }
}

/**
 * Two paths that differ only by letter case work on Linux but collide on Windows and macOS
 * (case-insensitive file systems), so a project that "works on my machine" would break for a
 * teammate. Reported as an error on every OS.
 */
export function detectCaseConflicts(relPaths: readonly string[]): Diagnostic[] {
  const seen = new Map<string, string>()
  const diagnostics: Diagnostic[] = []
  for (const path of [...relPaths].map(toPosix).sort(compareCodeUnits)) {
    const key = path.toLowerCase()
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, path)
    } else if (first !== path) {
      diagnostics.push(
        diagnosticForFile(
          'CASE_CONFLICT',
          'error',
          path,
          `"${path}" differs from "${first}" only by letter case.`,
          'Rename one of them. They collide on Windows and macOS, which ignore case.',
        ),
      )
    }
  }
  return diagnostics
}
