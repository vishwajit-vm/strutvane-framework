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
 * - **protected locations**: `.git/` (its hooks and config run code), `node_modules/` (installed
 *   code) and devkit's own transaction area `.strutvane/staging/` are never valid targets, at any
 *   depth and in any letter case. The rest of `.strutvane/` stays writable, because the ecosystem
 *   keeps generated state there (`lock.json`, `base/**`, `registry.gen.ts`, `README.md`). Only
 *   `transaction.ts` touches the staging area, through its own internal paths. The check runs on
 *   the path as written *and* on its real path, so a symlink, a junction or a Windows alias
 *   (`.GIT`, `.git.`, `.git::$DATA`, an 8.3 short name) cannot reach a protected folder either.
 *   Crash recovery applies a stricter rule on top ({@link recoveryRefusal}).
 *
 * @module
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DevkitError } from './errors.ts'

/** Top-level folder for devkit state. Kept equal to `STATE_DIR` in `transaction.ts` (tested). */
const STATE_FOLDER = '.strutvane'

/** Folder names devkit never reads or writes through, at any depth (compared canonically). */
const PROTECTED_FOLDERS: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/** `.strutvane/lock.json` and the copies `readLock` saves of a corrupt lock. */
const LOCK_FILE = /^lock\.json(?:\.corrupt-\d+)?$/

/**
 * The name Windows (and case-insensitive macOS volumes) actually opens for a path segment: an
 * alternate data stream suffix (`name:stream`) is dropped, trailing dots and spaces are ignored,
 * and case does not matter. Comparing canonical names means `.GIT`, `.git.` and `.git::$DATA`
 * are all recognised as `.git`.
 */
function canonicalSegment(segment: string): string {
  const colon = segment.indexOf(':')
  const name = colon >= 0 ? segment.slice(0, colon) : segment
  return name.replace(/[. ]+$/, '').toLowerCase()
}

/**
 * Why a normalised path (as segments) is protected, or `undefined` when devkit may touch it.
 * See the module documentation for the rules.
 */
function protectedReason(segments: readonly string[]): string | undefined {
  const names = segments.map(canonicalSegment)
  for (const [i, name] of names.entries()) {
    if (PROTECTED_FOLDERS.has(name)) {
      return `${name}/ is a protected location (devkit never touches .git or node_modules)`
    }
    if (name === STATE_FOLDER) {
      const next = names[i + 1]
      // The folder itself (as a file) or its transaction area, in this project or a nested one.
      if (next === undefined || next === 'staging') {
        return `${STATE_FOLDER}/staging/ is devkit's private transaction area`
      }
    }
  }
  return undefined
}

/**
 * The stricter rule crash recovery adds on top of {@link normaliseRelativePath}: a journal may
 * only restore project files, plus the upgrade state devkit's own transactions journal
 * (`.strutvane/lock.json` and `.strutvane/base/**`, so an interrupted upgrade can be undone).
 * Anything else under `.strutvane/` (generated registries, READMEs, …) is refused, because a
 * journal found on disk is untrusted. Returns the reason, or `undefined` when allowed.
 * `path` must already be normalised.
 */
export function recoveryRefusal(path: string): string | undefined {
  const names = path.split('/').map(canonicalSegment)
  if (names[0] !== STATE_FOLDER) return undefined
  const second = names[1] ?? ''
  if (names.length === 2 && LOCK_FILE.test(second)) return undefined
  if (second === 'base' && names.length > 2) return undefined
  return `recovery only restores project files, ${STATE_FOLDER}/lock.json and ${STATE_FOLDER}/base/**`
}

/**
 * Validate a project-relative POSIX path and return it normalised (no `./`, no duplicate slashes).
 *
 * Throws `path_outside_project` for traversal and absolute paths, and `invalid_path` for anything
 * else that isn't a plain relative path, including protected locations: `.git/`,
 * `node_modules/` and `.strutvane/staging/`, at any depth. Every devkit reader and writer goes
 * through this function, so no installer, generator, upgrade or recovery journal can target
 * those folders.
 */
export function normaliseRelativePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new DevkitError('invalid_path', 'path must be a non-empty string')
  }
  if (hasControlCharacter(path)) {
    throw new DevkitError(
      'invalid_path',
      `path contains control characters: ${JSON.stringify(path)}`,
    )
  }
  if (path.includes('\\')) {
    throw new DevkitError('invalid_path', `use forward slashes in project paths: ${path}`)
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || isAbsolute(path)) {
    throw new DevkitError('path_outside_project', `absolute paths are not allowed: ${path}`)
  }
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) {
    throw new DevkitError('path_outside_project', `path escapes the project: ${path}`)
  }
  if (parts.length === 0)
    throw new DevkitError('invalid_path', `path points at the project root: ${path}`)
  const reason = protectedReason(parts)
  if (reason !== undefined) throw new DevkitError('invalid_path', `${reason}: ${path}`)
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

/** How many links {@link realPathOf} follows before giving up (the usual OS limit is 40). */
const MAX_LINK_HOPS = 40

/**
 * The real (symlink-free, long-name) path of `absolute`: the real path of its deepest existing
 * ancestor, followed by the segments that do not exist yet.
 *
 * A *dangling* link is followed too: `realpath` fails on it, and treating it as a plain missing
 * file would let `settings.ini -> .git/config` pass while `.git/config` doesn't exist yet, after
 * which a write through the link would create the protected file. So when a segment is a link,
 * its target is resolved (relative to the link's folder) and checked instead.
 */
function realPathOf(absolute: string, hops = 0): string {
  let current = absolute
  const missing: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...[...missing].reverse())
    } catch {
      const target = linkTarget(current)
      if (target !== undefined) {
        if (hops >= MAX_LINK_HOPS) {
          throw new DevkitError('invalid_path', `too many levels of links: ${absolute}`)
        }
        const resolved = realPathOf(resolve(dirname(current), target), hops + 1)
        return join(resolved, ...[...missing].reverse())
      }
      const parent = resolve(current, '..')
      if (parent === current) return join(current, ...[...missing].reverse())
      missing.push(basename(current))
      current = parent
    }
  }
}

/** The raw target of `path` if it is a symbolic link (dangling or not), else `undefined`. */
function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
  } catch {
    return undefined
  }
}

/** True if `child` is `parent` or inside it (both absolute, same platform semantics). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Turn a project-relative path into an absolute one, guaranteeing that it stays inside
 * `projectRoot` even through symlinks or junctions (`path_outside_project` otherwise), and that
 * neither the path nor its real path is a protected location (`invalid_path`; see
 * {@link normaliseRelativePath}).
 */
export function resolveInsideProject(projectRoot: string, path: string): string {
  const rel = normaliseRelativePath(path)
  const root = resolve(projectRoot)
  const absolute = join(root, ...rel.split('/'))
  if (!isInside(root, absolute)) {
    throw new DevkitError('path_outside_project', `path escapes the project: ${path}`)
  }
  const realRoot = realPathOf(root)
  const realTarget = realPathOf(absolute)
  if (!isInside(realRoot, realTarget)) {
    throw new DevkitError(
      'path_outside_project',
      `path resolves outside the project through a symlink or junction: ${path}`,
    )
  }
  // A link inside the project (`docs -> .git`) or an alias must not reach a protected folder.
  const realSegments = relative(realRoot, realTarget)
    .split(sep)
    .filter((p) => p !== '')
  const reason = realSegments.length === 0 ? undefined : protectedReason(realSegments)
  if (reason !== undefined) {
    throw new DevkitError(
      'invalid_path',
      `${reason} (reached through a symlink, junction or alias): ${path}`,
    )
  }
  return absolute
}

/** Convert an absolute path inside `projectRoot` to a project-relative POSIX path. */
export function toProjectPath(projectRoot: string, absolute: string): string {
  return relative(resolve(projectRoot), absolute).split(sep).join('/')
}
