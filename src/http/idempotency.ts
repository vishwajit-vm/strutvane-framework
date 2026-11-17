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
import type { MiddlewareHandler } from 'hono'
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
 * One request asking to run under an `Idempotency-Key`.
 *
 * @example
 * const claim: IdempotencyClaim = { scope: callerScope(actor, tenantId, ip), key, method: 'POST', path: '/api/payments', search: '', request }
 */
export interface IdempotencyClaim {
  /** Who the key belongs to ({@link callerScope}): keys never cross users or tenants. */
  readonly scope: string
  /** The `Idempotency-Key` header value. */
  readonly key: string
  readonly method: string
  /** The path as the router serves it. */
  readonly path: string
  /** The query string (with its `?`), part of the fingerprint. */
  readonly search: string
  /** The request whose body is fingerprinted (read from a clone). */
  readonly request: Request
}

/**
 * What {@link startIdempotent} decided: run the action (then call {@link finishIdempotent}), or
 * answer with the stored response.
 *
 * @example
 * if (start.kind === 'replay') return start.response
 */
export type IdempotencyStart =
  | { readonly kind: 'run'; readonly storeKey: string }
  | { readonly kind: 'replay'; readonly response: Response }

/**
 * Who a key belongs to: the actor (and tenant), else the client address.
 *
 * @example
 * callerScope({ type: 'user', id: '7' }, 'acme', '203.0.113.7') // 'actor:user:7\nacme'
 */
export function callerScope(
  actor: { readonly type: string; readonly id: string | number } | null,
  tenantId: string | undefined,
  clientAddress: string | undefined,
): string {
  const tenant = tenantId ?? ''
  if (actor !== null) return `actor:${actor.type}:${String(actor.id)}\n${tenant}`
  return `anonymous:${clientAddress ?? 'unknown'}\n${tenant}`
}

/**
 * Claim a key, the shared first half of both idempotency middlewares. Throws the client-facing
 * errors: 400 `idempotency_key_invalid`, 409 `idempotency_in_progress` (with `Retry-After`),
 * 422 `idempotency_key_reused`.
 *
 * @example
 * const start = await startIdempotent(store, claim, clock.now())
 */
export async function startIdempotent(
  store: IdempotencyStore,
  claim: IdempotencyClaim,
  now: number,
): Promise<IdempotencyStart> {
  if (!KEY.test(claim.key)) throw new StrutvaneError('idempotency_key_invalid', { status: 400 })
  const storeKey = sha256(`${claim.scope}\n${claim.key}`)
  const fingerprint = sha256(
    `${claim.method}\n${claim.path}${claim.search}\n${await bodyDigest(claim.request)}`,
  )
  const outcome = await store.begin(storeKey, fingerprint, now)
  if (outcome.kind === 'in_progress')
    throw new StrutvaneError('idempotency_in_progress', {
      status: 409,
      headers: { 'Retry-After': '1' },
    })
  if (outcome.kind === 'mismatch')
    throw new StrutvaneError('idempotency_key_reused', { status: 422 })
  if (outcome.kind === 'replay') return { kind: 'replay', response: replay(outcome.response) }
  return { kind: 'run', storeKey }
}

/**
 * Settle a claimed key, the shared second half: store the response for replay, or release the
 * key (`undefined` = the action threw; a 5xx or a body over 1 MiB) so a retry runs for real.
 *
 * @example
 * await finishIdempotent(store, start.storeKey, response, clock.now())
 */
export async function finishIdempotent(
  store: IdempotencyStore,
  storeKey: string,
  response: Response | undefined,
  now: number,
): Promise<void> {
  // A thrown error or a 5xx means "it may not have happened": let the client retry for real.
  if (response === undefined || response.status >= 500) {
    await store.release(storeKey)
    return
  }
  const body = await readLimited(response.clone().body, MAX_STORED_BYTES)
  if (body === undefined) {
    await store.release(storeKey)
    return
  }
  const headers = REPLAYED_HEADERS.flatMap((name) => {
    const value = response.headers.get(name)
    return value === null ? [] : [[name, value] as const]
  })
  await store.complete(storeKey, { status: response.status, headers, body }, now)
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
    const s = c.get('sv')
    const now = options.now()
    const start = await startIdempotent(
      options.store,
      {
        scope: callerScope(s.actor, s.tenantId, s.clientAddress),
        key,
        method: c.req.method,
        path,
        search: new URL(c.req.url).search,
        request: c.req.raw,
      },
      now,
    )
    if (start.kind === 'replay') return start.response
    try {
      await next()
    } catch (error) {
      await options.store.release(start.storeKey)
      throw error
    }
    // Hono turned a thrown error into the response (c.error): it may not have happened.
    await finishIdempotent(
      options.store,
      start.storeKey,
      c.error === undefined ? c.res : undefined,
      now,
    )
    return undefined
  }
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
      // Not awaited: cancelling one branch of a cloned (tee'd) body settles only once the other
      // branch is cancelled too, so awaiting it here would hang the request.
      void reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
