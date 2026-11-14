/**
 * The framework's message catalog and error codes (RFC-0003). Messages are never hard-coded in
 * responses: every issue code and problem code below renders through the app's catalogs, which
 * can override any of them (`lang/<locale>/*.ts`).
 *
 * @module
 */
import {
  defineMessages,
  type ErrorDefinition,
  type ErrorRegistry,
  formatMessage,
  type MessageCatalog,
  type MessageLookup,
  type Messages,
} from '@strutvane/core'

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
  'errors.TENANT_REQUIRED.title': 'Workspace required',
  'errors.TENANT_REQUIRED.detail': 'Select a workspace (tenant) before doing this.',
  'errors.RECORD_IN_USE.title': 'Record in use',
  'errors.RECORD_IN_USE.detail': 'This {resource} is still referenced by other records.',
  'errors.MALFORMED_REQUEST.title': 'Malformed request',
  'errors.MALFORMED_REQUEST.detail': 'The request body could not be read.',
  'errors.UNSUPPORTED_MEDIA_TYPE.title': 'Unsupported media type',
  'errors.UNSUPPORTED_MEDIA_TYPE.detail': 'Send the request body as {expected}.',
  'errors.METHOD_NOT_ALLOWED.title': 'Method not allowed',
})

/** Error codes the framework registers (status + default title). */
export const FRAMEWORK_ERRORS: readonly ErrorDefinition[] = Object.freeze(
  (
    [
      ['TENANT_REQUIRED', 403, 'Workspace required'],
      ['RECORD_IN_USE', 409, 'Record in use'],
      ['MALFORMED_REQUEST', 400, 'Malformed request'],
      ['UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported media type'],
      ['METHOD_NOT_ALLOWED', 405, 'Method not allowed'],
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
