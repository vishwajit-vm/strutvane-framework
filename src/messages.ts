/**
 * The framework's message catalog and error codes (RFC-0003). Messages are never hard-coded in
 * responses: every issue code and problem code below renders through the app's catalogs, which
 * can override any of them (`lang/<locale>/*.ts`).
 *
 * @module
 */

import { CACHE_ERRORS, CACHE_MESSAGES_EN } from './cache/catalog.ts'
import {
  defineMessages,
  type ErrorDefinition,
  type ErrorRegistry,
  formatMessage,
  type MessageCatalog,
  type MessageLookup,
  type Messages,
} from './core/index.ts'
import { APP_ERRORS, APP_MESSAGES_EN } from './http/app/catalog.ts'
import { MAINTENANCE_ERRORS, MAINTENANCE_MESSAGES_EN } from './maintenance/catalog.ts'
import { SECURITY_ERRORS, SECURITY_MESSAGES_EN } from './security/catalog.ts'

/** English messages for the framework's issue and problem codes. */
export const FRAMEWORK_MESSAGES_EN: MessageCatalog = defineMessages('en', {
  'validation.unknown_field': '{attribute} is not a known field.',
  'validation.invalid_decimal': '{attribute} must be a decimal number with the allowed precision.',
  'validation.unknown_parameter': 'The query parameter "{name}" is not supported.',
  'validation.duplicate_parameter': 'The query parameter "{name}" may appear only once.',
  'validation.too_many_parameters': 'Too many query parameters (at most {max}).',
  'validation.filter_not_allowed': 'Filtering by {attribute} is not allowed.',
  'validation.operator_not_allowed': 'The operator "{operator}" is not allowed for {attribute}.',
  'validation.invalid_filter_value': 'The value for {attribute} ({operator}) is invalid.',
  'validation.relation_path_unsupported':
    'Filtering through relations ({attribute}) is not supported yet.',
  'validation.filter_too_complex': 'The filter is too complex.',
  'validation.invalid_filter': 'The filter is invalid.',
  'validation.sort_not_allowed': 'Sorting by "{field}" is not allowed.',
  'validation.too_many_sorts': 'Sort by at most {max} fields.',
  'validation.invalid_page_size': 'Page size must be between 1 and {max}.',
  'validation.invalid_page_number': 'Page number must be a positive whole number.',
  'validation.conflicting_pagination': 'Use either a page cursor or a page number, not both.',
  'validation.invalid_cursor':
    'The page cursor is invalid or expired. Start again from the first page.',
  'validation.include_not_allowed': 'Including "{relation}" is not allowed.',
  'validation.too_many_includes': 'Include at most {max} relations.',
  'validation.page_too_deep':
    'Page numbers can reach at most {max} records deep. Use the page cursor to go further.',
  'validation.total_not_allowed': 'A total count is not available for this list.',
  'errors.tenant_required.title': 'Workspace required',
  'errors.tenant_required.detail': 'Select a workspace (tenant) before doing this.',
  'errors.record_in_use.title': 'Record in use',
  'errors.record_in_use.detail': 'This {resource} is still referenced by other records.',
  'errors.malformed_request.title': 'Malformed request',
  'errors.malformed_request.detail': 'The request body could not be read.',
  'errors.unsupported_media_type.title': 'Unsupported media type',
  'errors.unsupported_media_type.detail': 'Send the request body as {expected}.',
  'errors.method_not_allowed.title': 'Method not allowed',
  'errors.untrusted_host.title': 'Untrusted host',
  'errors.untrusted_host.detail': 'This server does not answer for the requested host name.',
  'errors.idempotency_key_invalid.title': 'Invalid idempotency key',
  'errors.idempotency_key_invalid.detail':
    'The Idempotency-Key must be 1 to 255 visible ASCII characters.',
  'errors.idempotency_in_progress.title': 'Request in progress',
  'errors.idempotency_in_progress.detail':
    'A request with this Idempotency-Key is still being processed. Retry shortly.',
  'errors.idempotency_key_reused.title': 'Idempotency key reused',
  'errors.idempotency_key_reused.detail':
    'This Idempotency-Key was already used for a different request. Use a new key for a new request.',
  'errors.csrf_token_mismatch.title': 'Page expired',
  'errors.csrf_token_mismatch.detail':
    'This request could not be verified as coming from this site. Reload the page and try again.',
})

/** Error codes the framework registers (status + default title). */
export const FRAMEWORK_ERRORS: readonly ErrorDefinition[] = Object.freeze(
  (
    [
      ['tenant_required', 403, 'Workspace required'],
      ['record_in_use', 409, 'Record in use'],
      ['malformed_request', 400, 'Malformed request'],
      ['unsupported_media_type', 415, 'Unsupported media type'],
      ['method_not_allowed', 405, 'Method not allowed'],
      // 419 "Page expired", Laravel's status for a failed CSRF check (CONSISTENCY #30).
      ['csrf_token_mismatch', 419, 'Page expired'],
      // An unknown Host header (CONSISTENCY #20, Laravel/Symfony behaviour).
      ['untrusted_host', 400, 'Untrusted host'],
      // Idempotency-Key (IETF httpapi draft).
      ['idempotency_key_invalid', 400, 'Invalid idempotency key'],
      ['idempotency_in_progress', 409, 'Request in progress'],
      ['idempotency_key_reused', 422, 'Idempotency key reused'],
    ] as const
  ).map(([code, status, title]) =>
    Object.freeze({ code, status, title, owner: '@strutvane/framework' }),
  ),
)

/** Register the framework's error codes (idempotent: codes already present are skipped). */
export function registerFrameworkErrors(registry: ErrorRegistry): void {
  for (const definition of FRAMEWORK_ERRORS)
    if (!registry.get(definition.code)) registry.register(definition)
}

/**
 * The extra codes of an application (`bootstrap/app.ts`): the security kit, the HTTP kernel,
 * maintenance mode and the cache. Kept apart from {@link FRAMEWORK_ERRORS} so a v1
 * `createHttpApp` project registers only the codes it can return.
 *
 * @example
 * APPLICATION_ERRORS.map((definition) => definition.code) // ['invalid_signature', …, 'maintenance_mode', 'cache_unavailable']
 */
export const APPLICATION_ERRORS: readonly ErrorDefinition[] = Object.freeze([
  ...SECURITY_ERRORS,
  ...APP_ERRORS,
  ...MAINTENANCE_ERRORS,
  ...CACHE_ERRORS,
])

/**
 * English messages for {@link APPLICATION_ERRORS}, plus the application's friendlier wording of a
 * few validation messages (it wins over {@link FRAMEWORK_MESSAGES_EN} for an application).
 *
 * @example
 * APPLICATION_MESSAGES_EN.messages['errors.maintenance_mode.title'] // 'Down for maintenance'
 */
export const APPLICATION_MESSAGES_EN: MessageCatalog = defineMessages('en', {
  ...SECURITY_MESSAGES_EN,
  ...APP_MESSAGES_EN,
  ...MAINTENANCE_MESSAGES_EN,
  ...CACHE_MESSAGES_EN,
})

/**
 * Register every code an application can return (framework + application codes), skipping codes a
 * package already registered.
 *
 * @example
 * registerApplicationErrors(app.make(ErrorRegistryToken))
 */
export function registerApplicationErrors(registry: ErrorRegistry): void {
  for (const definition of [...FRAMEWORK_ERRORS, ...APPLICATION_ERRORS])
    if (registry.get(definition.code) === undefined) registry.register(definition)
}

/**
 * An application's messages: the app's own catalogs first, then the application catalog, then the
 * framework catalog.
 *
 * @example
 * const messages = applicationMessages(app.make(MessagesToken))
 */
export function applicationMessages(messages: Messages): Messages {
  return withFrameworkMessages(messages, [FRAMEWORK_MESSAGES_EN, APPLICATION_MESSAGES_EN])
}

/**
 * Layer the framework catalog *under* the app's messages: the app (and every package it
 * configured) wins; the framework only fills keys nobody else defines.
 */
export function withFrameworkMessages(
  messages: Messages,
  catalogs: readonly MessageCatalog[] = [FRAMEWORK_MESSAGES_EN],
): Messages {
  const own = new Map<string, Readonly<Record<string, string>>>()
  for (const c of catalogs) own.set(c.locale, { ...own.get(c.locale), ...c.messages })
  const ownResolve = (key: string, lookup?: MessageLookup): string | undefined => {
    const locale = lookup?.locale
    const chain = locale ? [locale, locale.split('-')[0] ?? locale, 'en'] : ['en']
    for (const l of chain) {
      const hit = own.get(l)?.[key]
      if (hit !== undefined) return hit
    }
    return undefined
  }
  return {
    resolve: (key, lookup) => messages.resolve(key, lookup) ?? ownResolve(key, lookup),
    has: (key, lookup) => messages.has(key, lookup) || ownResolve(key, lookup) !== undefined,
    format(key, params, lookup) {
      if (messages.has(key, lookup)) return messages.format(key, params, lookup)
      const template = ownResolve(key, lookup)
      if (template === undefined) return messages.format(key, params, lookup)
      return formatMessage(template, params ?? {}, lookup?.locale ?? 'en').text
    },
    locales: () => [...new Set([...messages.locales(), ...own.keys()])],
    missingKeys: (locale) => messages.missingKeys(locale),
  }
}
