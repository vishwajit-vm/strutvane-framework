/**
 * The client-facing problem code of maintenance mode (RFC-0003), lowercase `snake_case`
 * (CONSISTENCY #68).
 *
 * - `maintenance_mode` (503): the app is down (`node strut down`). The response carries
 *   `Retry-After` and `Refresh` when `down` was given `--retry` and `--refresh`.
 *
 * @module
 */
import type { ErrorDefinition } from '../core/errors/registry.ts'

/**
 * The maintenance problem code with its status and default title.
 *
 * @example
 * for (const definition of MAINTENANCE_ERRORS) registry.register(definition)
 */
export const MAINTENANCE_ERRORS: readonly ErrorDefinition[] = Object.freeze([
  Object.freeze({
    code: 'maintenance_mode',
    status: 503,
    title: 'Down for maintenance',
    owner: '@strutvane/framework',
  }),
])

/**
 * English title and detail for {@link MAINTENANCE_ERRORS}.
 *
 * @example
 * MAINTENANCE_MESSAGES_EN['errors.maintenance_mode.detail']
 */
export const MAINTENANCE_MESSAGES_EN: Readonly<Record<string, string>> = Object.freeze({
  'errors.maintenance_mode.title': 'Down for maintenance',
  'errors.maintenance_mode.detail':
    'The application is down for maintenance. Please try again in a few minutes.',
})
