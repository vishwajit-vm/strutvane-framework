/**
 * The client-facing problem code of the cache (RFC-0003), lowercase `snake_case`
 * (CONSISTENCY #68).
 *
 * - `cache_unavailable` (503): the file store could not take its per-key lock in time (another
 *   process holds it far longer than any cache write takes). The request may be retried; the
 *   cache is never written without the lock, so counters (rate limits) are never lost or doubled.
 *
 * @module
 */
import type { ErrorDefinition } from '../core/errors/registry.ts'

/**
 * The cache problem code with its status and default title.
 *
 * @example
 * for (const definition of CACHE_ERRORS) registry.register(definition)
 */
export const CACHE_ERRORS: readonly ErrorDefinition[] = Object.freeze([
  Object.freeze({
    code: 'cache_unavailable',
    status: 503,
    title: 'Cache temporarily unavailable',
    owner: '@strutvane/framework',
  }),
])

/**
 * English title and detail for {@link CACHE_ERRORS}.
 *
 * @example
 * CACHE_MESSAGES_EN['errors.cache_unavailable.detail']
 */
export const CACHE_MESSAGES_EN: Readonly<Record<string, string>> = Object.freeze({
  'errors.cache_unavailable.title': 'Cache temporarily unavailable',
  'errors.cache_unavailable.detail': 'The server is busy. Please try again in a moment.',
})
