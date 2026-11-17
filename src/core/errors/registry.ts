/**
 * The error-code registry: the single list of every problem code the app can return, with its
 * HTTP status and default title (RFC-0003 §3). Packages register their own codes at boot; the docs
 * site generates its error reference from the same data.
 *
 * Registering a code twice is an error, so two packages can never silently disagree about what a
 * code means.
 *
 * @module
 */
import type { ProblemCode } from '../../contracts/index.ts'
import { currentErrorCode, warnUppercaseCode } from './legacy-codes.ts'

/** What a problem code means. */
export interface ErrorDefinition {
  /**
   * Lowercase `snake_case` (CONSISTENCY #68). An app's own `SCREAMING_SNAKE_CASE` code is still
   * accepted through the 0.2 line, with a deprecation warning (#123).
   */
  readonly code: string
  /** Default HTTP status (an error instance may override it). */
  readonly status: number
  /** Default English title, used when no catalog defines `errors.<code>.title`. */
  readonly title: string
  /** Which package registered it (for `node strut doctor` and duplicate errors). */
  readonly owner?: string
}

/** A registry of error codes. */
export interface ErrorRegistry {
  register(definition: ErrorDefinition): void
  get(code: string): ErrorDefinition | undefined
  /** Every definition, sorted by code. */
  list(): readonly ErrorDefinition[]
}

/** One case per code: `csrf_token_mismatch` (or, until 0.3, an app's `INVOICE_PAID`), never `Not_Found`. */
const CODE = /^(?:[A-Z][A-Z0-9_]*|[a-z][a-z0-9_]*)$/

/** The built-in codes from the framework's contracts (RFC-0002 and RFC-0003). */
export const BUILTIN_ERRORS: readonly ErrorDefinition[] = Object.freeze(
  (
    [
      ['validation_failed', 422, 'Validation failed'],
      ['unauthenticated', 401, 'Sign-in required'],
      ['forbidden', 403, 'Not allowed'],
      ['not_found', 404, 'Not found'],
      ['conflict', 409, 'Conflict'],
      ['stale_record', 409, 'Changed by someone else'],
      ['rate_limited', 429, 'Too many requests'],
      ['payload_too_large', 413, 'Request too large'],
      ['service_unavailable', 503, 'Temporarily unavailable'],
      ['internal_error', 500, 'Something went wrong'],
      ['file_too_large', 413, 'File too large'],
      ['too_many_files', 413, 'Too many files'],
      ['file_empty', 422, 'Empty file'],
      ['file_type_not_allowed', 422, 'File type not allowed'],
      ['file_corrupt', 422, 'File could not be read'],
      ['image_dimensions_invalid', 422, 'Image size not allowed'],
      ['upload_incomplete', 400, 'Upload incomplete'],
      ['storage_unavailable', 503, 'Storage temporarily unavailable'],
      ['quota_exceeded', 422, 'Storage quota exceeded'],
      ['file_infected', 422, 'File rejected'],
      ['scan_unavailable', 503, 'File scanning temporarily unavailable'],
    ] as const satisfies readonly (readonly [ProblemCode, number, string])[]
  ).map(([code, status, title]) =>
    Object.freeze({ code, status, title, owner: '@strutvane/framework' }),
  ),
)

/** Create a registry, pre-filled with {@link BUILTIN_ERRORS} unless `builtin` is false. */
export function createErrorRegistry(options: { readonly builtin?: boolean } = {}): ErrorRegistry {
  const definitions = new Map<string, ErrorDefinition>()
  const registry: ErrorRegistry = {
    register(given) {
      // An old uppercase name registers under its new name (deprecation warning, CONSISTENCY #123),
      // so it collides with the built-in exactly as the old name did.
      const definition = { ...given, code: currentErrorCode(given.code) }
      if (!CODE.test(definition.code)) {
        throw new TypeError(
          `Error code "${definition.code}" must be lowercase snake_case, such as "invoice_already_paid"`,
        )
      }
      if (
        !Number.isInteger(definition.status) ||
        definition.status < 400 ||
        definition.status > 599
      ) {
        throw new RangeError(
          `Error code "${definition.code}": status must be an HTTP error status (400-599)`,
        )
      }
      if (/[A-Z]/.test(definition.code)) warnUppercaseCode(definition.code)
      const existing = definitions.get(definition.code)
      if (existing) {
        throw new Error(
          `Error code "${definition.code}" is already registered by ${existing.owner ?? 'another package'}`,
        )
      }
      definitions.set(definition.code, Object.freeze({ ...definition }))
    },
    // An old uppercase name finds its renamed definition (with a one-time deprecation warning).
    get: (code) => definitions.get(code) ?? definitions.get(currentErrorCode(code)),
    list: () => [...definitions.values()].sort((a, b) => a.code.localeCompare(b.code)),
  }
  if (options.builtin !== false) for (const d of BUILTIN_ERRORS) registry.register(d)
  return registry
}
