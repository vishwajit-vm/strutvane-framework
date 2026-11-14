/**
 * Well-known container tokens (integration map §3). Packages resolve these instead of importing
 * each other: e.g. `@strutvane/logs` rebinds {@link LoggerToken}, and every package that logs
 * through it automatically uses the full logger.
 *
 * @module
 */
import type { Logger, PermissionProvider } from '../contracts/index.ts'
import type { Clock } from './clock.ts'
import { type Token, token } from './container.ts'
import type { ErrorRegistry } from './errors/registry.ts'
import type { EventBus } from './events.ts'
import type { HookRegistry } from './hooks.ts'
import type { Messages } from './messages/catalog.ts'
import type { UuidGenerator } from './uuid.ts'

/** The application logger. Core binds a default; `@strutvane/logs` replaces it. */
export const LoggerToken: Token<Logger> = token<Logger>('strutvane.logger')
/** The clock (inject a TestClock in tests). */
export const ClockToken: Token<Clock> = token<Clock>('strutvane.clock')
/** UUIDv7 id generator. */
export const IdGeneratorToken: Token<UuidGenerator> = token<UuidGenerator>('strutvane.ids')
/** Message catalogs (RFC-0003). */
export const MessagesToken: Token<Messages> = token<Messages>('strutvane.messages')
/** Error-code registry (RFC-0003). */
export const ErrorRegistryToken: Token<ErrorRegistry> = token<ErrorRegistry>('strutvane.errors')
/** The application event bus. Event names are open-ended at this level. */
export const EventBusToken: Token<EventBus<Record<string, unknown>>> =
  token<EventBus<Record<string, unknown>>>('strutvane.events')
/** The application hook registry. Hook names are open-ended at this level. */
export const HooksToken: Token<HookRegistry<Record<string, unknown>>> =
  token<HookRegistry<Record<string, unknown>>>('strutvane.hooks')
/** Decides permissions. Provided by `@strutvane/auth`; absent otherwise (see the integration map). */
export const PermissionProviderToken: Token<PermissionProvider> =
  token<PermissionProvider>('strutvane.permissions')
