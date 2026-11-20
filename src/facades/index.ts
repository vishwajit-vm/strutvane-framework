/**
 * Facades: typed static accessors that resolve from the **current application's container** on
 * every call (CONSISTENCY #47, #80). Swap one in a test by binding a different value in that
 * app's container; two apps in one process never see each other's services.
 *
 * Available now: `Log`, `Cache`, `DB`, `Route`, `Storage`, `Http`, `Event`, `Crypt`, `Url`.
 * Arriving in 0.3 (every member throws `facade_not_available`): `Mail`, `Queue`, `Bus`,
 * `Notification`, `Hash`.
 *
 * @example
 * import { Cache, Log } from '@strutvane/framework/facades'
 * const stats = await Cache.remember('stats', 60, () => computeStats())
 * Log.info('Stats served', { cached: true })
 *
 * @module
 */
export { Cache, type CacheFacade } from './cache.ts'
export { Bus, type ComingSoon, Hash, Mail, Notification, Queue } from './coming-soon.ts'
export { Crypt, type CryptFacade } from './crypt.ts'
export { DB, type DbFacade } from './db.ts'
export { Event, type EventFacade } from './event.ts'
export { type FacadeBinding, notAvailable, resolveFacade } from './facade.ts'
export { Http, type HttpFacade } from './http.ts'
export { Log, type LogChannel, type LogFacade, type LogFacadeMethod, logger } from './log.ts'
export { Route, type RouteFacade } from './route.ts'
export { Storage, type StorageFacade } from './storage.ts'
export { Url, type UrlFacade } from './url.ts'
