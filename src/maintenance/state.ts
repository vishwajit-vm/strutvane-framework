/**
 * The maintenance-mode state file, `storage/framework/down` (Laravel's), written by
 * `node strut down` and removed by `node strut up`.
 *
 * **Why a file:** it survives restarts, and every process serving the app (cluster workers,
 * several containers on a shared volume) reads the same state, without a database or Redis.
 *
 * - Written atomically (temporary file + rename), so a reader sees the old state or the new one.
 * - Read on every request by `stat` only: the file is parsed again only when its modification
 *   time, size or inode changed. The inode matters because an atomic rename can land in the same
 *   millisecond as the previous write (spike 12 finding 13).
 * - A file that can't be parsed keeps the app **down** with the plain 503 (fail closed: a
 *   half-written deploy should not serve traffic).
 * - Every field is checked again when read (a hand-edited file can't smuggle in an off-site
 *   redirect or a huge page).
 *
 * @module
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { safeRedirectTarget } from '../security/redirect.ts'
import { parseJsonSafely } from '../security/safe-json.ts'
import { removeFile, writeFileAtomic } from '../support/atomic-write.ts'

/**
 * The state file, relative to the app.
 *
 * @example
 * join(basePath, DOWN_FILE) // '/srv/blog/storage/framework/down'
 */
export const DOWN_FILE: string = join('storage', 'framework', 'down')

/**
 * The largest pre-rendered page `--render` accepts (and the state file may carry).
 *
 * @example
 * MAX_PAGE_BYTES // 262144
 */
export const MAX_PAGE_BYTES: number = 256 * 1024

/** `Retry-After` and `Refresh` values: whole seconds up to a week. */
const MAX_SECONDS = 7 * 24 * 60 * 60

/**
 * What `node strut down` wrote.
 *
 * @example
 * const state: MaintenanceState = { since: 1763200000, retry: 60 }
 */
export interface MaintenanceState {
  /** Unix seconds when maintenance started. */
  readonly since: number
  /** The `Retry-After` header, in seconds. */
  readonly retry?: number
  /** The `Refresh` header, in seconds (browsers reload the page). */
  readonly refresh?: number
  /** HMAC of the bypass secret; the secret itself is never stored. */
  readonly secretHash?: string
  /** A same-origin path every other request is redirected to. */
  readonly redirect?: string
  /** A pre-rendered HTML page (from `--render`), so it shows even when views can't load. */
  readonly html?: string
}

/**
 * Put the app into maintenance mode (an atomic write; every process sees it on its next request).
 *
 * @example
 * writeMaintenance('/srv/blog', { since: 1763200000, retry: 60 })
 */
export function writeMaintenance(basePath: string, state: MaintenanceState): void {
  writeFileAtomic(join(basePath, DOWN_FILE), `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Bring the app back up. Returns `false` when it wasn't down.
 *
 * @example
 * clearMaintenance('/srv/blog') // true
 */
export function clearMaintenance(basePath: string): boolean {
  return removeFile(join(basePath, DOWN_FILE))
}

/** Parsed states by file path, with the `stat` version they were parsed at. */
const parsed = new Map<string, { readonly version: string; readonly state: MaintenanceState }>()

/**
 * The current state, or `undefined` when the app is up. Costs one `stat` per call; the file is
 * parsed again only when it changed.
 *
 * @example
 * if (readMaintenance('/srv/blog') !== undefined) console.log('down')
 */
export function readMaintenance(basePath: string): MaintenanceState | undefined {
  const path = join(basePath, DOWN_FILE)
  let version: string
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return parsedState(path, 'not-a-file', () => ({ since: 0 }))
    version = `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      parsed.delete(path)
      return undefined
    }
    // Present but unreadable (permissions): stay down.
    return { since: 0 }
  }
  return parsedState(path, version, () => parseState(path))
}

function parsedState(
  path: string,
  version: string,
  parse: () => MaintenanceState,
): MaintenanceState {
  const cached = parsed.get(path)
  if (cached !== undefined && cached.version === version) return cached.state
  const state = parse()
  parsed.set(path, { version, state })
  return state
}

/** Parse and re-check the file; anything wrong becomes the plain "down" state. */
function parseState(path: string): MaintenanceState {
  let value: unknown
  try {
    value = parseJsonSafely(readFileSync(path, 'utf8'), { maxDepth: 2, maxKeys: 20 })
  } catch {
    return { since: 0 }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { since: 0 }
  const record = value as Record<string, unknown>
  const seconds = (name: string): number | undefined => {
    const field = record[name]
    return typeof field === 'number' &&
      Number.isInteger(field) &&
      field >= 0 &&
      field <= MAX_SECONDS
      ? field
      : undefined
  }
  const since = record['since']
  const retry = seconds('retry')
  const refresh = seconds('refresh')
  const secretHash =
    typeof record['secretHash'] === 'string' && /^[a-f0-9]{64}$/.test(record['secretHash'])
      ? record['secretHash']
      : undefined
  const redirect =
    typeof record['redirect'] === 'string'
      ? safeRedirectTarget(record['redirect'], 'http://localhost')
      : undefined
  const html =
    typeof record['html'] === 'string' && Buffer.byteLength(record['html']) <= MAX_PAGE_BYTES
      ? record['html']
      : undefined
  return {
    since: typeof since === 'number' && Number.isInteger(since) ? since : 0,
    ...(retry === undefined ? {} : { retry }),
    ...(refresh === undefined ? {} : { refresh }),
    ...(secretHash === undefined ? {} : { secretHash }),
    ...(redirect === undefined ? {} : { redirect }),
    ...(html === undefined ? {} : { html }),
  }
}
