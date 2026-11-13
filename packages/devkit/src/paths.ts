/**
 * Project-relative path handling: the single choke point that keeps installers, generators and
 * upgrades inside the project.
 *
 * Threats handled (each covered by tests):
 * - path traversal (`../../etc/passwd`, `a/../../b`),
 * - absolute paths (`/etc/x`, `C:\x`, `\\server\share`),
 * - backslash tricks on Windows (`..\x`),
 * - NUL / control characters (truncation attacks in native APIs),
 * - **symlink / junction escape**: `link/x.txt` where `link` points outside the project. Checked
 *   by resolving the real path of the deepest existing ancestor.
 *
 * @module
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DevkitError } from './errors.ts'

/**
 * Validate a project-relative POSIX path and return it normalised (no `./`, no duplicate slashes).
 * Throws `INVALID_PATH` for anything that isn't a plain relative path inside the project.
 */
export function normaliseRelativePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new DevkitError('INVALID_PATH', 'path must be a non-empty string')
  }
  if (hasControlCharacter(path)) {
    throw new DevkitError(
      'INVALID_PATH',
      `path contains control characters: ${JSON.stringify(path)}`,
    )
  }
  if (path.includes('\\')) {
    throw new DevkitError('INVALID_PATH', `use forward slashes in project paths: ${path}`)
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || isAbsolute(path)) {
    throw new DevkitError('PATH_OUTSIDE_PROJECT', `absolute paths are not allowed: ${path}`)
  }
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) {
    throw new DevkitError('PATH_OUTSIDE_PROJECT', `path escapes the project: ${path}`)
  }
  if (parts.length === 0)
    throw new DevkitError('INVALID_PATH', `path points at the project root: ${path}`)
  return parts.join('/')
}

/** True for C0 control characters and DEL: never legitimate in a file name, often an injection attempt. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/** Resolve the real (symlink-free) path of the deepest existing ancestor of `absolute`. */
function realAncestor(absolute: string): string {
  let current = absolute
  for (;;) {
    try {
      return realpathSync.native(current)
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return current
      current = parent
    }
  }
}

/** True if `child` is `parent` or inside it (both absolute, same platform semantics). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Turn a project-relative path into an absolute one, guaranteeing it stays inside `projectRoot`
 * even through symlinks or junctions. Throws `PATH_OUTSIDE_PROJECT` otherwise.
 */
export function resolveInsideProject(projectRoot: string, path: string): string {
  const rel = normaliseRelativePath(path)
  const root = resolve(projectRoot)
  const absolute = join(root, ...rel.split('/'))
  if (!isInside(root, absolute)) {
    throw new DevkitError('PATH_OUTSIDE_PROJECT', `path escapes the project: ${path}`)
  }
  const realRoot = realAncestor(root)
  const realTarget = realAncestor(absolute)
  if (!isInside(realRoot, realTarget)) {
    throw new DevkitError(
      'PATH_OUTSIDE_PROJECT',
      `path resolves outside the project through a symlink or junction: ${path}`,
    )
  }
  return absolute
}

/** Convert an absolute path inside `projectRoot` to a project-relative POSIX path. */
export function toProjectPath(projectRoot: string, absolute: string): string {
  return relative(resolve(projectRoot), absolute).split(sep).join('/')
}
