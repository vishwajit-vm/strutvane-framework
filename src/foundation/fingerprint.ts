/**
 * A fingerprint of the app's code, stored in every bootstrap cache. A cache whose fingerprint
 * differs from the code on disk was built from another version and is ignored (with a warning),
 * so a deploy that forgot `node strut optimize` can never run on stale routes or config.
 *
 * What is hashed: the framework version, then every file under `app/`, `routes/`, `config/` and
 * `bootstrap/` (except `bootstrap/cache/`), `.strutvane/resources.json` and `package.json`, by
 * relative path and content: everything routes, policies, bindings and config come from.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import manifest from '../../package.json' with { type: 'json' }

/**
 * The framework version, part of every cache header (a framework upgrade invalidates caches).
 *
 * @example
 * FRAMEWORK_VERSION // '0.1.0-next.1'
 */
export const FRAMEWORK_VERSION: string = manifest.version

const FOLDERS = ['app', 'routes', 'config', 'bootstrap']
const FILES = [join('.strutvane', 'resources.json'), 'package.json']
const SKIPPED: ReadonlySet<string> = new Set([join('bootstrap', 'cache'), 'node_modules'])

/**
 * The code fingerprint of an app (hex SHA-256).
 *
 * @example
 * codeFingerprint('/srv/blog') // '9f2c…'
 */
export function codeFingerprint(basePath: string): string {
  const hash = createHash('sha256').update(FRAMEWORK_VERSION)
  const files = [
    ...FOLDERS.flatMap((folder) => listFiles(basePath, join(basePath, folder))),
    ...FILES.map((file) => join(basePath, file)).filter((file) => existsSync(file)),
  ].sort()
  for (const file of files) {
    // Forward slashes, so the same tree hashes the same on Windows and POSIX.
    hash.update(`\n${relative(basePath, file).split(sep).join('/')}\n`).update(readFileSync(file))
  }
  return hash.digest('hex')
}

function listFiles(basePath: string, folder: string): string[] {
  if (!existsSync(folder) || SKIPPED.has(relative(basePath, folder))) return []
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name)
    return statSync(path).isDirectory() ? listFiles(basePath, path) : [path]
  })
}
