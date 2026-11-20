/**
 * Request context carried implicitly through async calls (AsyncLocalStorage), so every log line
 * written while handling a request is enriched with its ids (request, trace, tenant, user), without
 * passing a logger around.
 *
 * Each `runWithLogContext` call opens a *scope*. `Log.withContext()` adds values to the current
 * scope only (this request), and `Log.withoutContext()` removes them again, like Laravel's
 * `Log::withContext()` / `Log::withoutContext()`.
 *
 * **Request id, user id and tenant id are added automatically.** The framework's own request
 * context (core's `runWithContext`, set by the HTTP kernel once the request hooks resolved the
 * actor and tenant) is read on every log call and merged under this module's scope, so a record
 * written anywhere while a request is handled carries `requestId`, `traceId`, `actorId` (the
 * signed-in user) and `tenantId` without any code. Values set explicitly with
 * {@link runWithLogContext} win over the request's.
 *
 * Loggers still accept an injected {@link ContextGetter} (tests, custom hosts).
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { currentContext, type RequestContext } from '../core/context.ts'

/** Correlation fields added to every record. Extra keys are kept under `fields`. */
export interface LogContext {
  readonly requestId?: string
  readonly traceId?: string
  readonly tenantId?: string
  /** The signed-in user (or other actor). */
  readonly actorId?: string
  readonly [key: string]: unknown
}

/** Returns the current context, or `undefined` outside any request. */
export type ContextGetter = () => LogContext | undefined

/** One scope's values. Mutable on purpose: `withContext` adds to the scope it is called in. */
type Scope = Record<string, unknown>

const storage = new AsyncLocalStorage<Scope>()
/** Keys each scope received through `addToLogContext` (so clearing them keeps the request ids). */
const added = new WeakMap<Scope, Set<string>>()

/**
 * Run `fn` with `context` visible to every log call made inside it, synchronously or
 * asynchronously. Nested calls start from the outer scope's values (inner values win), and values
 * added inside never leak out.
 *
 * @example
 * runWithLogContext({ requestId: 'req-1', tenantId: 't-9' }, async () => {
 *   log.info('Invoice sent') // → { …, requestId: 'req-1', tenantId: 't-9' }
 * })
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const outer = storage.getStore()
  return storage.run({ ...outer, ...context }, fn)
}

/**
 * The correlation ids of a framework request context: request, trace, user (`actorId`) and
 * tenant. Absent values are left out.
 *
 * @example
 * requestIds({ requestId: 'r1', actor: { id: 'u7', type: 'user' } }) // { requestId: 'r1', actorId: 'u7' }
 */
export function requestIds(request: RequestContext): LogContext {
  const ids: Record<string, string> = {}
  if (request.requestId) ids['requestId'] = request.requestId
  if (request.traceId) ids['traceId'] = request.traceId
  if (request.actor?.id) ids['actorId'] = request.actor.id
  if (request.tenant?.id) ids['tenantId'] = request.tenant.id
  return ids
}

/**
 * The current context: the framework request's ids (see {@link requestIds}) merged under this
 * module's scope, or `undefined` outside any request and scope.
 */
export const getLogContext: ContextGetter = () => {
  const scope = storage.getStore()
  const request = currentContext()
  if (request === undefined) return scope
  const ids = requestIds(request)
  return scope === undefined ? ids : { ...ids, ...scope }
}

/**
 * Add values to the current scope (this request). Returns `false` outside any scope, so the caller
 * can decide where process-wide values go.
 *
 * @example
 * runWithLogContext({ requestId: 'r1' }, () => addToLogContext({ orderId: 42 }))
 */
export function addToLogContext(values: Readonly<Record<string, unknown>>): boolean {
  const scope = storage.getStore()
  if (!scope) return false
  let keys = added.get(scope)
  if (!keys) {
    keys = new Set()
    added.set(scope, keys)
  }
  for (const key of Object.keys(values)) keys.add(key)
  Object.assign(scope, values)
  return true
}

/**
 * Remove values from the current scope: the given keys, or, when none are given, every key added
 * with {@link addToLogContext} (the request's own ids stay). Returns `false` outside any scope.
 *
 * @example
 * removeFromLogContext(['orderId'])
 */
export function removeFromLogContext(keys?: readonly string[]): boolean {
  const scope = storage.getStore()
  if (!scope) return false
  const own = added.get(scope)
  for (const key of keys ?? [...(own ?? [])]) {
    delete scope[key]
    own?.delete(key)
  }
  return true
}
