/**
 * `Idempotency-Key` support (IETF httpapi Idempotency-Key draft; ported from spike 12). A client
 * sends `Idempotency-Key: <unique>` with a create, a delete or a custom POST (a payment, an
 * import), and a retry with the same key gets the *first* response replayed instead of running
 * the action twice. That is what makes "retry is safe" true for `@strutvane/ui` and any client on
 * a flaky network.
 *
 * | Situation | Answer |
 * |---|---|
 * | no key | runs normally (the header is opt-in per request) |
 * | malformed key | 400 `idempotency_key_invalid` |
 * | first use | runs; a non-5xx response up to 1 MiB is stored for 24 h |
 * | same key, same method, path and body, finished | the stored response, `Idempotent-Replayed: true` |
 * | same key, still running | 409 `idempotency_in_progress`, `Retry-After: 1` |
 * | same key, different body, method or path | 422 `idempotency_key_reused` |
 *
 * Keys are scoped to the caller (actor and tenant, or the client address for anonymous callers),
 * so one user can never be served another user's stored response by guessing or reusing their
 * key. Only `content-type` and `location` are replayed: never `set-cookie` or other per-request
 * headers. A 5xx (or a thrown error) releases the key: "it may not have happened", so the retry
 * runs for real.
 *
 * Applies to POST and DELETE, except the read-only `POST /<resource>/query`.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { StrutvaneError, type Token, token } from '../core/index.ts'
import type { HttpEnv } from './resource-routes.ts'
import { routerPath } from './router-path.ts'

/** A response kept for replay. */
export interface StoredResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: string
}

/** What a store says about a key when a request starts. */
export type BeginOutcome =
  | { readonly kind: 'new' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'replay'; readonly response: StoredResponse }

/**
 * Where keys and responses live. The memory store suits one process; a cluster binds a shared
 * store (a database table, Redis) under {@link IdempotencyStoreToken}, with an atomic `begin`.
 *
 * @example
 * app.container.value(IdempotencyStoreToken, new MemoryIdempotencyStore({ maxEntries: 50_000 }))
 */
export interface IdempotencyStore {
  /** Atomically claim `key` for this fingerprint, or report what already holds it. */
  begin(key: string, fingerprint: string, now: number): Promise<BeginOutcome>
  /** Store the finished response for replay. */
  complete(key: string, response: StoredResponse, now: number): Promise<void>
  /** Forget an unfinished claim (the action failed), so a retry runs again. */
  release(key: string): Promise<void>
}

/**
 * The container token for the idempotency store (connection 2). Bound to a
 * {@link MemoryIdempotencyStore} by `createHttpApp` unless the app bound its own first.
 */
export const IdempotencyStoreToken: Token<IdempotencyStore> = token<IdempotencyStore>(
  'strutvane.http.idempotencyStore',
)

/** How long a finished response is replayed (24 h, the draft's suggestion). */
export const IDEMPOTENCY_TTL_MS: number = 24 * 60 * 60 * 1000

/** Default bound on stored keys for the memory store. */
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES: number = 10_000

interface Entry {
  readonly fingerprint: string
  response: StoredResponse | undefined
  expiresAt: number
}

/**
 * The in-memory store, bounded in both time and size: entries expire after `ttlMs`, and when
 * `maxEntries` is reached the oldest entry is dropped (insertion order), so a flood of distinct
 * keys can never grow memory without limit. An in-flight claim expires too, so a crashed request
 * cannot block its key forever.
 *
 * @example
 * new MemoryIdempotencyStore({ maxEntries: 10_000, ttlMs: 24 * 3600_000 })
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, Entry>()
  readonly #max: number
  readonly #ttl: number

  constructor(options: { readonly maxEntries?: number; readonly ttlMs?: number } = {}) {
    this.#max = options.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES
    this.#ttl = options.ttlMs ?? IDEMPOTENCY_TTL_MS
    if (!Number.isSafeInteger(this.#max) || this.#max < 1)
      throw new RangeError('idempotency maxEntries must be a positive integer')
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 1)
      throw new RangeError('idempotency ttlMs must be a positive integer')
  }

  /** How many keys are held right now. */
  get size(): number {
    return this.#entries.size
  }

  async begin(key: string, fingerprint: string, now: number): Promise<BeginOutcome> {
    const entry = this.#entries.get(key)
    if (entry !== undefined && entry.expiresAt <= now) this.#entries.delete(key)
    const live = entry !== undefined && entry.expiresAt > now ? entry : undefined
    if (live === undefined) {
      this.#makeRoom(now)
      this.#entries.set(key, { fingerprint, response: undefined, expiresAt: now + this.#ttl })
      return { kind: 'new' }
    }
    if (live.fingerprint !== fingerprint) return { kind: 'mismatch' }
    return live.response === undefined
      ? { kind: 'in_progress' }
      : { kind: 'replay', response: live.response }
  }

  async complete(key: string, response: StoredResponse, now: number): Promise<void> {
    const entry = this.#entries.get(key)
    if (entry === undefined) return
    entry.response = response
    entry.expiresAt = now + this.#ttl
  }

  async release(key: string): Promise<void> {
    this.#entries.delete(key)
  }

  /** Drop expired entries, then the oldest ones, until one more fits. */
  #makeRoom(now: number): void {
    if (this.#entries.size < this.#max) return
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key)
    for (const key of this.#entries.keys()) {
      if (this.#entries.size < this.#max) break
      this.#entries.delete(key)
    }
  }
}

/** Visible ASCII, 1 to 255 characters (UUIDs, ULIDs and the like fit). */
const KEY = /^[\x21-\x7e]{1,255}$/
const REPLAYED_HEADERS = ['content-type', 'location'] as const
/** Responses bigger than this are not stored (the action ran once; a retry runs again). */
const MAX_STORED_BYTES = 1024 * 1024
const METHODS: ReadonlySet<string> = new Set(['POST', 'DELETE'])

/** Options for {@link idempotency}. */
export interface IdempotencyMiddlewareOptions {
  readonly store: IdempotencyStore
  readonly now: () => number
  /** Paths that are reads in POST clothing (`/<resource>/query`): never stored or replayed. */
  readonly reads: readonly RegExp[]
}

/**
 * The middleware. Registered after the request hooks (it needs the actor and tenant to scope
 * keys) and after the body limit (the body it fingerprints is already bounded).
 *
 * @example
 * http.use('*', idempotency({ store, now: () => clock.now(), reads: [/^\/api\/v1\/[^/]+\/query$/] }))
 */
export function idempotency(options: IdempotencyMiddlewareOptions): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const key = c.req.header('idempotency-key')
    if (key === undefined || !METHODS.has(c.req.method)) return next()
    const path = routerPath(c.req.raw)
    if (options.reads.some((pattern) => pattern.test(path))) return next()
    if (!KEY.test(key)) throw new StrutvaneError('idempotency_key_invalid', { status: 400 })
    const storeKey = sha256(`${callerScope(c)}\n${key}`)
    const fingerprint = sha256(
      `${c.req.method}\n${path}${new URL(c.req.url).search}\n${await bodyDigest(c.req.raw)}`,
    )
    const now = options.now()
    const outcome = await options.store.begin(storeKey, fingerprint, now)
    if (outcome.kind === 'in_progress')
      throw new StrutvaneError('idempotency_in_progress', {
        status: 409,
        headers: { 'Retry-After': '1' },
      })
    if (outcome.kind === 'mismatch')
      throw new StrutvaneError('idempotency_key_reused', { status: 422 })
    if (outcome.kind === 'replay') return replay(outcome.response)
    try {
      await next()
    } catch (error) {
      await options.store.release(storeKey)
      throw error
    }
    await remember(options, storeKey, c, now)
    return undefined
  }
}

/** Who the key belongs to: the actor (and tenant), else the client address. */
function callerScope(c: Context<HttpEnv>): string {
  const s = c.get('sv')
  const tenant = s.tenantId ?? ''
  if (s.actor !== null) return `actor:${s.actor.type}:${s.actor.id}\n${tenant}`
  return `anonymous:${s.clientAddress ?? 'unknown'}\n${tenant}`
}

async function remember(
  options: IdempotencyMiddlewareOptions,
  storeKey: string,
  c: Context<HttpEnv>,
  now: number,
): Promise<void> {
  // A 5xx (Hono turned a thrown error into the response) means "it may not have happened":
  // let the client retry for real.
  if (c.error !== undefined || c.res.status >= 500) {
    await options.store.release(storeKey)
    return
  }
  const body = await readLimited(c.res.clone().body, MAX_STORED_BYTES)
  if (body === undefined) {
    await options.store.release(storeKey)
    return
  }
  const headers = REPLAYED_HEADERS.flatMap((name) => {
    const value = c.res.headers.get(name)
    return value === null ? [] : [[name, value] as const]
  })
  await options.store.complete(storeKey, { status: c.res.status, headers, body }, now)
}

function replay(stored: StoredResponse): Response {
  const headers = new Headers()
  for (const [name, value] of stored.headers) headers.set(name, value)
  headers.set('Idempotent-Replayed', 'true')
  const empty = stored.status === 204 || stored.status === 304
  return new Response(empty ? null : stored.body, { status: stored.status, headers })
}

/** SHA-256 of the body, read from a clone so the handler still gets it. */
async function bodyDigest(request: Request): Promise<string> {
  if (request.body === null) return ''
  const hash = createHash('sha256')
  const reader = request.clone().body?.getReader()
  if (!reader) return ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  return hash.digest('hex')
}

/** A body as text, or `undefined` when it is bigger than `limit` bytes. */
async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | undefined> {
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
