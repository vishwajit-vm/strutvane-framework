/**
 * The session store seam. Sessions, login and token rotation belong to `@strutvane/auth`; the
 * framework only needs to *flush* every session after an incident (`node strut session:flush`)
 * and to know whether a request carries one (the CSRF check keys on the session cookie name,
 * CONSISTENCY #105).
 *
 * The auth package binds its store under {@link SessionStoreToken}; without one, the framework's
 * file store (`storage/framework/sessions`) is used.
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'

/**
 * What the framework asks of a session store.
 *
 * @example
 * const removed = await app.make(SessionStoreToken).flush()
 */
export interface SessionStore {
  /** Remove every session; returns how many were removed (when the store can tell). */
  flush(): Promise<number>
}

/**
 * The container token for the session store.
 *
 * @example
 * app.container.value(SessionStoreToken, myStore)
 */
export const SessionStoreToken: Token<SessionStore> = token<SessionStore>('strutvane.sessions')
