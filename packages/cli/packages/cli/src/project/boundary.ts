/**
 * Which folders may be treated as a Strutvane project.
 *
 * Treating a folder as the project means importing code from its `node_modules` (contributed
 * commands, installers) and reading its `.env`. So a folder only counts when:
 * - it is a project: its package.json declares `@strutvane/cli` (dependencies or devDependencies)
 *   or it contains `strutvane.config.ts`;
 * - it is not a file-system or drive root, not the OS temp directory itself and not a folder above
 *   the user's home directory: anyone able to write there (other users, extracted archives) could
 *   otherwise plant a project that applies to every folder below it;
 * - on POSIX, it is owned by the current user.
 *
 * The `strutvane` launcher applies the same rules before delegating (its `launcher.ts`; it has no
 * dependencies, so the rules are mirrored there rather than imported). Keep the two in step.
 *
 * @module
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Facts the rules depend on (injectable, so tests can place "home" and "temp" anywhere). */
export interface BoundaryFacts {
  readonly home: string
  readonly temp: string
  /** The current uid on POSIX; `undefined` where ownership is not checked (Windows). */
  readonly uid: number | undefined
}

/** The boundary facts of this process. */
export function processBoundary(): BoundaryFacts {
  return {
    home: homedir(),
    temp: tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
  }
}

function spellings(path: string): string[] {
  const out = [resolve(path)]
  try {
    out.push(realpathSync(path))
  } catch {
    // a missing path has only its given spelling
  }
  return out
}

function samePath(a: string, b: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin'
  const norm = (p: string): string => (fold ? resolve(p).toLowerCase() : resolve(p))
  return norm(a) === norm(b)
}

function isStrictAncestor(ancestor: string, path: string): boolean {
  const rel = relative(ancestor, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** A file-system or drive root, the temp directory itself, or a folder above home. */
export function isForbiddenProjectDir(dir: string, facts: BoundaryFacts): boolean {
  for (const d of spellings(dir)) {
    if (dirname(d) === d) return true
    for (const temp of spellings(facts.temp)) if (samePath(d, temp)) return true
    for (const home of spellings(facts.home)) if (isStrictAncestor(d, home)) return true
  }
  return false
}

/** POSIX only: whether `dir` is owned by the current user (always `true` without a uid). */
export function isOwnedByCurrentUser(dir: string, facts: BoundaryFacts): boolean {
  if (facts.uid === undefined) return true
  try {
    return statSync(dir).uid === facts.uid
  } catch {
    return false
  }
}

/** Whether a package.json object declares `@strutvane/cli` in dependencies or devDependencies. */
export function declaresCli(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false
  return ['dependencies', 'devDependencies'].some((field) => {
    const deps = (manifest as Record<string, unknown>)[field]
    return (
      typeof deps === 'object' &&
      deps !== null &&
      Object.hasOwn(deps, '@strutvane/cli') &&
      typeof (deps as Record<string, unknown>)['@strutvane/cli'] === 'string'
    )
  })
}

/** Read `<dir>/package.json` leniently (any failure: `undefined`). */
export function readManifest(dir: string): unknown {
  try {
    const text = readFileSync(resolve(dir, 'package.json'), 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return undefined
  }
}
