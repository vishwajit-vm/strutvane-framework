/**
 * The container token for the app's log manager (the object behind the `Log` facade).
 *
 * The application binds it when it is created; `LoggerToken` (the `Logger` contract every package
 * logs through) resolves to the same manager by default, so `Log.info()`, an injected `Logger`
 * and the exception handler all write to the channels of `config/logging.ts`.
 *
 * Why two tokens: `LoggerToken` is the narrow contract a test can swap for a memory logger
 * (`app.container.value(LoggerToken, memory)`) without losing the manager's channel features,
 * and packages that only need to log depend on the contract, never on the manager.
 *
 * @module
 */
import { type Token, token } from '../core/container.ts'
import type { LogManager } from './manager.ts'

/**
 * The app's log manager: channels, stacks, `build`, shared and per-request context.
 *
 * @example
 * app.make(LogManagerToken).channel('payments').info('Paid', { invoiceId: 42 })
 */
export const LogManagerToken: Token<LogManager> = token<LogManager>('strutvane.log-manager')
