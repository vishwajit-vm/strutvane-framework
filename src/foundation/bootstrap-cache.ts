/**
 * The bootstrap caches written by `config:cache`, `route:cache` and `event:cache` (and all three by
 * `optimize`), in `bootstrap/cache/<kind>.json`, like Laravel.
 *
 * Every cache is **encrypted and authenticated** with an `APP_KEY` subkey
 * (`keyring.derive('cache.<kind>')`), and carries a header with the key id and the code
 * fingerprint. A cache is ignored, with a warning naming the reason, when:
 * - it was built with another `APP_KEY` (a copied `bootstrap/cache`, or a rotated key);
 * - it was built from another code version (a deploy that forgot `node strut optimize`);
 * - it was changed by hand, truncated, or is from another cache format.
 *
 * **Why encrypt:** the config cache holds every secret the config files read (database
 * passwords, API keys). Laravel writes them in plain PHP; here a leaked `bootstrap/cache` is
 * useless without `APP_KEY`, and a tampered one is refused instead of trusted.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../contracts/logger.ts'
import { openSealed, packSealed, seal, unpackSealed } from '../security/aead.ts'
import type { AppKey, Keyring } from '../security/keyring.ts'
import { parseJsonSafely } from '../security/safe-json.ts'
import { removeFile, writeFileAtomic } from '../support/atomic-write.ts'
import { codeFingerprint, FRAMEWORK_VERSION } from './fingerprint.ts'

/**
 * The three bootstrap caches.
 *
 * @example
 * const kind: CacheKind = 'routes'
 */
export type CacheKind = 'config' | 'routes' | 'events'

/**
 * Where the caches live, relative to the app.
 *
 * @example
 * join(basePath, CACHE_FOLDER) // '/srv/blog/bootstrap/cache'
 */
export const CACHE_FOLDER: string = join('bootstrap', 'cache')

const FORMAT = 1

/**
 * What happened to a cache at boot, for `about` and tests.
 *
 * @example
 * app.cacheStatus.routes // 'used'
 */
export type CacheUse = 'none' | 'used' | 'ignored'

interface CacheFile {
  readonly format: number
  readonly kind: CacheKind
  readonly framework: string
  readonly keyId: string
  readonly code: string
  readonly createdAt: string
  readonly payload: string
}

/**
 * The file a cache lives in.
 *
 * @example
 * cachePath('/srv/blog', 'config') // '/srv/blog/bootstrap/cache/config.json'
 */
export function cachePath(basePath: string, kind: CacheKind): string {
  return join(basePath, CACHE_FOLDER, `${kind}.json`)
}

function cacheKey(keyring: Keyring, kind: CacheKind, key?: AppKey): Buffer {
  return keyring.derive(`cache.${kind}`, key)
}

/**
 * Write a cache (atomically, mode 0600) for the current key and code.
 *
 * @example
 * writeCache('/srv/blog', 'config', keyring, tree, new Date())
 */
export function writeCache(
  basePath: string,
  kind: CacheKind,
  keyring: Keyring,
  payload: unknown,
  now: Date,
  fingerprint: () => string = () => codeFingerprint(basePath),
): void {
  const header = {
    format: FORMAT,
    kind,
    framework: FRAMEWORK_VERSION,
    keyId: keyring.current.id,
    code: fingerprint(),
    createdAt: now.toISOString(),
  }
  const sealed = seal(
    cacheKey(keyring, kind),
    Buffer.from(JSON.stringify(payload), 'utf8'),
    additionalData(header),
  )
  const file: CacheFile = { ...header, payload: packSealed(sealed).toString('base64') }
  writeFileAtomic(cachePath(basePath, kind), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Read a cache: `used` with the payload, `none` when there is no file, or `ignored` (with a
 * warning through `logger`) when it is stale, from another key or tampered with. Pass
 * `fingerprint` to share one code hash between the three caches of a boot (hashing the app's
 * files is the slowest part of reading a cache).
 *
 * @example
 * const { use, payload } = readCache(basePath, 'config', keyring, logger)
 */
export function readCache(
  basePath: string,
  kind: CacheKind,
  keyring: Keyring,
  logger: Pick<Logger, 'warn'>,
  fingerprint: () => string = () => codeFingerprint(basePath),
): { readonly use: CacheUse; readonly payload: unknown } {
  const path = cachePath(basePath, kind)
  if (!existsSync(path)) return { use: 'none', payload: undefined }
  const ignore = (reason: string): { use: CacheUse; payload: unknown } => {
    const command = kind === 'routes' ? 'route' : kind === 'events' ? 'event' : 'config'
    logger.warn(
      `Ignoring bootstrap/cache/${kind}.json: ${reason} Run \`node strut ${command}:cache\` (or \`node strut optimize\`) again.`,
    )
    return { use: 'ignored', payload: undefined }
  }
  const file = parseCacheFile(readFileSync(path, 'utf8'))
  if (file === undefined || file.format !== FORMAT || file.kind !== kind)
    return ignore('it is not a cache this version can read.')
  const key = keyring.byId(file.keyId)
  if (key === undefined) return ignore('it was built with a different APP_KEY.')
  if (file.framework !== FRAMEWORK_VERSION || file.code !== fingerprint())
    return ignore('it was built from another version of the code.')
  try {
    const plaintext = openSealed(
      cacheKey(keyring, kind, key),
      unpackSealed(Buffer.from(file.payload, 'base64')),
      additionalData(file),
    )
    return {
      use: 'used',
      payload: parseJsonSafely(plaintext.toString('utf8'), { maxDepth: 64, maxKeys: 1_000_000 }),
    }
  } catch {
    return ignore('it was changed after it was written.')
  }
}

/**
 * Delete a cache. Returns `true` when there was one.
 *
 * @example
 * clearCache('/srv/blog', 'routes')
 */
export function clearCache(basePath: string, kind: CacheKind): boolean {
  return removeFile(cachePath(basePath, kind))
}

/** The header is authenticated too, so a cache can't be relabelled as another kind or version. */
function additionalData(header: Omit<CacheFile, 'payload'>): string {
  return `strutvane:bootstrap-cache:${header.format}:${header.kind}:${header.framework}:${header.keyId}:${header.code}:${header.createdAt}`
}

function parseCacheFile(text: string): CacheFile | undefined {
  let value: unknown
  try {
    value = parseJsonSafely(text, { maxDepth: 4, maxKeys: 50 })
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const strings = ['kind', 'framework', 'keyId', 'code', 'createdAt', 'payload'] as const
  if (
    typeof record['format'] !== 'number' ||
    !strings.every((name) => typeof record[name] === 'string')
  )
    return undefined
  const kind = record['kind']
  if (kind !== 'config' && kind !== 'routes' && kind !== 'events') return undefined
  return {
    format: record['format'],
    kind,
    framework: String(record['framework']),
    keyId: String(record['keyId']),
    code: String(record['code']),
    createdAt: String(record['createdAt']),
    payload: String(record['payload']),
  }
}
