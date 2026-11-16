/**
 * The application core's client-facing problem codes and their English wording (RFC-0003). Codes
 * are lowercase `snake_case` (CONSISTENCY #68). Codes the framework already registered are reused
 * in their current spelling (`METHOD_NOT_ALLOWED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`,
 * `RATE_LIMITED`, `csrf_token_mismatch`, `untrusted_host`, the `idempotency_*` codes, and the
 * security kit's `invalid_signature`/`signature_expired`).
 *
 * - `idempotency_key_required`: a route with the `idempotent` middleware got no `Idempotency-Key`.
 * - `invalid_method_override`: a form's `_method` field asked for something other than PUT,
 *   PATCH or DELETE (spoofing a POST into a GET or TRACE is refused, like Symfony).
 *
 * Validation issue codes the core produces (`unknown_field`, `taken`, `invalid_body`) have
 * catalog messages too, for issues raised without one.
 *
 * @module
 */
import type { ErrorDefinition } from '../../core/errors/registry.ts'

const OWNER = '@strutvane/framework'

/**
 * The application core's problem codes, with their status and default title.
 *
 * @example
 * for (const definition of APP_ERRORS) registry.register(definition)
 */
export const APP_ERRORS: readonly ErrorDefinition[] = Object.freeze(
  (
    [
      ['idempotency_key_required', 400, 'Idempotency key required'],
      ['invalid_method_override', 400, 'Invalid method override'],
    ] as const
  ).map(([code, status, title]) => Object.freeze({ code, status, title, owner: OWNER })),
)

/**
 * English titles, details and issue messages for {@link APP_ERRORS}.
 *
 * @example
 * APP_MESSAGES_EN['errors.idempotency_key_required.detail']
 */
export const APP_MESSAGES_EN: Readonly<Record<string, string>> = Object.freeze({
  'errors.idempotency_key_required.title': 'Idempotency key required',
  'errors.idempotency_key_required.detail':
    'Send an "Idempotency-Key" header with a unique value (a UUID), so a retry can never repeat this action.',
  'errors.invalid_method_override.title': 'Invalid method override',
  'errors.invalid_method_override.detail':
    'The "_method" field may only turn a POST form into PUT, PATCH or DELETE.',
  'validation.unknown_field':
    '"{attribute}" is not a field you can send here. Remove it from the request body.',
  'validation.taken': 'That {attribute} is already taken.',
  'validation.invalid_body': 'Send a JSON object with the fields as its keys.',
})
