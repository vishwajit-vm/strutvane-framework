/**
 * The request context: who is calling, for which tenant, with which trace id, in which language.
 *
 * **Why AsyncLocalStorage?** Passing `actor`, `tenant` and `traceId` through every function call
 * pollutes every signature and is easy to forget. AsyncLocalStorage carries them implicitly across
 * `await`, timers and callbacks, scoped to one request, so two concurrent requests never see each
 * other's context.
 *
 * @module
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Actor, TenantContext } from '@strutvane/contracts'

/** Data about the current request. Every field is optional. */
export interface RequestContext {
  /** Unique id for this request (also returned to the client for support). */
  readonly requestId?: string
  /** OpenTelemetry trace id. */
  readonly traceId?: string
  /** The authenticated actor, `null` for anonymous requests, absent when not resolved yet. */
  readonly actor?: Actor | null
  /** The resolved tenant, when multi-tenancy is enabled. */
  readonly tenant?: TenantContext
  /** BCP 47 locale for messages, e.g. `"en"`, `"hi-IN"`. */
  readonly locale?: string
  /** Extra package-specific values. Keys should be namespaced, e.g. `"logs.sampled"`. */
  readonly extras?: Readonly<Record<string, unknown>>
}

const storage = new AsyncLocalStorage<RequestContext>()

/**
 * Run `fn` with a context. Nested calls inherit the outer context and override only the fields
 * given (`extras` are merged), so middleware can add the actor after the request id is set.
 */
export function runWithContext<R>(context: RequestContext, fn: () => R): R {
  const parent = storage.getStore()
  const merged: RequestContext = parent
    ? {
        ...parent,
        ...context,
        ...(parent.extras || context.extras
          ? { extras: Object.freeze({ ...parent.extras, ...context.extras }) }
          : {}),
      }
    : context
  return storage.run(Object.freeze(merged), fn)
}

/** The current request context, or `undefined` outside of any request. Never throws. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore()
}
