/**
 * Path helpers that make output identical on Windows, macOS and Linux.
 *
 * Rules:
 * - Every path the compiler stores or emits is project-relative and uses `/`.
 * - Sorting compares UTF-16 code units (`<`), never `localeCompare`, whose result depends on the
 *   machine's locale and ICU version.
 */
import { relative } from 'node:path'

/** Convert any path to POSIX separators. */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Project-relative POSIX path of an absolute path. */
export function relativePosix(root: string, absolute: string): string {
  return toPosix(relative(root, absolute))
}

/** Locale-independent, total ordering of strings. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Resolve a relative import specifier (`../models/invoice.model.ts`) from a project-relative
 * importer (`app/resources/invoice.resource.ts`) to a project-relative path. Returns `undefined`
 * for bare specifiers (packages) and for paths that escape the project.
 */
export function resolveRelativeImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  const parts = importer.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return parts.join('/')
}
