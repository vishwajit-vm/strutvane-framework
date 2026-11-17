/**
 * The security kit's client-facing problem codes and their English wording (RFC-0003). Codes are
 * lowercase `snake_case` (CONSISTENCY #68); the wording lives here, never inline where the error
 * is thrown, so apps can translate or override it (`lang/<locale>/*.ts`).
 *
 * - `invalid_signature`, `signature_expired`: a signed link was tampered with, signed for
 *   something else, already used (one-time links) or past its expiry. Always 403 (CONSISTENCY #67).
 * - `invalid_json`, `forbidden_json_key`: a body that is not JSON, or that carries `__proto__` or
 *   `constructor.prototype` (400).
 * - `json_too_deep`, `json_too_many_keys`: a body over the configured limits (413).
 *
 * The SSRF-safe HTTP client never throws a client-facing error: an outgoing request failing is
 * the server's problem, and its details (resolved addresses) must not reach a client.
 *
 * @module
 */
import type { ErrorDefinition } from '../core/errors/registry.ts'

const OWNER = '@strutvane/framework'

/**
 * The security kit's problem codes, with their status and default title.
 *
 * @example
 * for (const definition of SECURITY_ERRORS) registry.register(definition)
 */
export const SECURITY_ERRORS: readonly ErrorDefinition[] = Object.freeze(
  (
    [
      ['invalid_signature', 403, 'Invalid link'],
      ['signature_expired', 403, 'Link expired'],
      ['invalid_json', 400, 'Invalid JSON'],
      ['forbidden_json_key', 400, 'Forbidden JSON key'],
      ['json_too_deep', 413, 'JSON nested too deeply'],
      ['json_too_many_keys', 413, 'Too many JSON keys'],
    ] as const
  ).map(([code, status, title]) => Object.freeze({ code, status, title, owner: OWNER })),
)

/**
 * English titles and details for {@link SECURITY_ERRORS}, keyed `errors.<code>.title|detail`.
 *
 * @example
 * SECURITY_MESSAGES_EN['errors.signature_expired.detail'] // 'This link has expired…'
 */
export const SECURITY_MESSAGES_EN: Readonly<Record<string, string>> = Object.freeze({
  'errors.invalid_signature.title': 'Invalid link',
  'errors.invalid_signature.detail':
    'This link is not valid. It may have been changed or copied incompletely. Ask for a new one.',
  'errors.signature_expired.title': 'Link expired',
  'errors.signature_expired.detail':
    'This link has expired or has already been used. Ask for a new one.',
  'errors.invalid_json.title': 'Invalid JSON',
  'errors.invalid_json.detail':
    'The request body is not valid JSON. Check for trailing commas and unquoted keys.',
  'errors.forbidden_json_key.title': 'Forbidden JSON key',
  'errors.forbidden_json_key.detail':
    'The request body contains a "__proto__" key or a "constructor.prototype" object, which is never accepted.',
  'errors.json_too_deep.title': 'JSON nested too deeply',
  'errors.json_too_deep.detail': 'The request body is nested deeper than this server accepts.',
  'errors.json_too_many_keys.title': 'Too many JSON keys',
  'errors.json_too_many_keys.detail': 'The request body has more keys than this server accepts.',
})
