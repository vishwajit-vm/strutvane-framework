/**
 * Boot guards (ported from spike 12): settings so dangerous that the app refuses to start with
 * them, instead of starting and hoping nobody notices.
 *
 * 1. `APP_DEBUG=true` with `APP_ENV=production` (CONSISTENCY #19). The debug page is impossible
 *    in production anyway, but the combination almost always means a development `.env` was
 *    deployed, with its development keys and passwords. `--force-debug` starts anyway, with a
 *    logged warning, for a deliberate short investigation.
 * 2. A missing, short or malformed `APP_KEY` (or entry in `APP_PREVIOUS_KEYS`). Everything signed
 *    or encrypted depends on it; a weak key is a forgeable key. The message names the variable,
 *    never the value.
 *
 * @module
 */
import { BootError } from '../foundation/boot-error.ts'
import { Keyring } from './keyring.ts'

/**
 * What the guards look at.
 *
 * @example
 * const input: BootGuardInput = { environment: 'production', debug: false, appKey: env.APP_KEY, previousKeys: '', forceDebug: false }
 */
export interface BootGuardInput {
  /** `APP_ENV`. */
  readonly environment: string
  /** `APP_DEBUG`, already parsed. */
  readonly debug: boolean
  /** `APP_KEY`. */
  readonly appKey: string | undefined
  /** `APP_PREVIOUS_KEYS` (comma-separated). Default none. */
  readonly previousKeys?: string | undefined
  /** `--force-debug` was given. Default `false`. */
  readonly forceDebug?: boolean
}

/**
 * What the guards hand back when the app may start.
 *
 * @example
 * const { keyring, warnings }: BootGuardResult = checkBootGuards(input)
 */
export interface BootGuardResult {
  /** The parsed keys (parsed once, here). */
  readonly keyring: Keyring
  /** Warnings to log through the `Logger` (never `console`). */
  readonly warnings: readonly string[]
}

/**
 * Run the guards. Returns the keyring and any warnings to log; throws a friendly `BootError`
 * (`debug_in_production`, `invalid_app_key`) when the app must not start.
 *
 * @example
 * const { keyring, warnings } = checkBootGuards({ environment, debug, appKey, previousKeys, forceDebug })
 * for (const warning of warnings) logger.warn(warning)
 */
export function checkBootGuards(input: BootGuardInput): BootGuardResult {
  const warnings: string[] = []
  if (input.debug && input.environment === 'production') {
    if (input.forceDebug !== true)
      throw new BootError(
        'debug_in_production',
        'The app refuses to start: APP_DEBUG=true with APP_ENV=production.',
        'Set APP_DEBUG=false in the production environment. To start anyway for a short investigation, pass --force-debug (debug pages stay off in production either way).',
      )
    warnings.push(
      'Started with --force-debug: APP_DEBUG=true in production. Debug pages stay off; turn APP_DEBUG off again as soon as possible.',
    )
  }
  return {
    keyring: Keyring.from(input.appKey, input.previousKeys ?? ''),
    warnings: Object.freeze(warnings),
  }
}
