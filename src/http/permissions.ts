/**
 * Resolving the PermissionProvider for HTTP requests: **deny unless provided**.
 *
 * `@strutvane/auth` (or any other implementation) binds `PermissionProviderToken`. Without one:
 * - `APP_ENV=local`: allow everything, with a loud warning, so a fresh app is explorable;
 * - `publicApi: true`: allow everything, explicitly chosen (and still warned about);
 * - anything else: **refuse to start** (integration map §3). A production API without
 *   authorization must be a visible decision, never an accident.
 *
 * @module
 */
import type {
  Actor,
  Decision,
  Logger,
  Permission,
  PermissionProvider,
  QueryFilter,
} from '@strutvane/contracts'
import type { Application } from '@strutvane/core'
import { PermissionProviderToken } from '@strutvane/core'

/** A provider that allows everything. Only for local development or an explicit public API. */
export function allowAllPermissions(): PermissionProvider {
  const decision: Decision = { allowed: true, reason: 'allow-all (no PermissionProvider bound)' }
  return {
    can: async () => decision,
    filterFor: async (): Promise<QueryFilter> => ({ op: 'true' }),
  }
}

/** A provider that denies everything (the safe default for tests of the deny path). */
export function denyAllPermissions(): PermissionProvider {
  const decision: Decision = { allowed: false, reason: 'default-deny' }
  return {
    can: async () => decision,
    filterFor: async (): Promise<QueryFilter> => ({ op: 'false' }),
  }
}

/** Thrown at startup when no PermissionProvider is bound outside local development. */
export class MissingPermissionProviderError extends Error {
  override readonly name = 'MissingPermissionProviderError'
}

/** Options for {@link resolvePermissionProvider}. */
export interface PermissionResolution {
  /** `APP_ENV` (e.g. `local`, `staging`, `production`). */
  readonly env: string
  /** Explicitly serve the API without authorization. */
  readonly publicApi?: boolean
  readonly logger?: Logger
}

/** The provider to use for this app, applying the rules above. */
export function resolvePermissionProvider(
  app: Application,
  options: PermissionResolution,
): PermissionProvider {
  if (app.container.has(PermissionProviderToken)) return app.make(PermissionProviderToken)
  if (options.env === 'local' || options.publicApi === true) {
    options.logger?.warn(
      'No PermissionProvider is bound: every request is ALLOWED. Install @strutvane/auth before deploying.',
      { env: options.env, publicApi: options.publicApi === true },
    )
    return allowAllPermissions()
  }
  throw new MissingPermissionProviderError(
    `No PermissionProvider is bound and APP_ENV is "${options.env}". Install @strutvane/auth, bind ` +
      'PermissionProviderToken, or set publicApi: true to serve the API without authorization.',
  )
}

/** `invoice.viewAny`, `invoice.create`, … */
export function permissionFor(prefix: string, action: string): Permission {
  return `${prefix}.${action}`
}

/** A helper type for code that checks permissions for the current actor. */
export type Can = (actor: Actor | null, permission: Permission) => Promise<Decision>
