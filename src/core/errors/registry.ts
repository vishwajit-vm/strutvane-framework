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
import type { ProblemCode } from '@strutvane/contracts'

/** What a problem code means. */
export interface ErrorDefinition {
  /** `SCREAMING_SNAKE_CASE`. */
  readonly code: string
  /** Default HTTP status (an error instance may override it). */
  readonly status: number
  /** Default English title, used when no catalog defines `errors.<code>.title`. */
  readonly title: string
  /** Which package registered it (for `sv doctor` and duplicate errors). */
  readonly owner?: string
}

/** A registry of error codes. */
export interface ErrorRegistry {
  register(definition: ErrorDefinition): void
  get(code: string): ErrorDefinition | undefined
  /** Every definition, sorted by code. */
  list(): readonly ErrorDefinition[]
}

const CODE = /^[A-Z][A-Z0-9_]*$/

/** The built-in codes from `@strutvane/contracts` (RFC-0002 and RFC-0003). */
export const BUILTIN_ERRORS: readonly ErrorDefinition[] = Object.freeze(
  (
    [
      ['VALIDATION_FAILED', 422, 'Validation failed'],
      ['UNAUTHENTICATED', 401, 'Sign-in required'],
      ['FORBIDDEN', 403, 'Not allowed'],
      ['NOT_FOUND', 404, 'Not found'],
      ['CONFLICT', 409, 'Conflict'],
      ['STALE_RECORD', 409, 'Changed by someone else'],
      ['RATE_LIMITED', 429, 'Too many requests'],
      ['PAYLOAD_TOO_LARGE', 413, 'Request too large'],
      ['SERVICE_UNAVAILABLE', 503, 'Temporarily unavailable'],
      ['INTERNAL_ERROR', 500, 'Something went wrong'],
      ['FILE_TOO_LARGE', 413, 'File too large'],
      ['TOO_MANY_FILES', 413, 'Too many files'],
      ['FILE_EMPTY', 422, 'Empty file'],
      ['FILE_TYPE_NOT_ALLOWED', 422, 'File type not allowed'],
      ['FILE_CORRUPT', 422, 'File could not be read'],
      ['IMAGE_DIMENSIONS_INVALID', 422, 'Image size not allowed'],
      ['UPLOAD_INCOMPLETE', 400, 'Upload incomplete'],
      ['STORAGE_UNAVAILABLE', 503, 'Storage temporarily unavailable'],
      ['QUOTA_EXCEEDED', 422, 'Storage quota exceeded'],
      ['FILE_INFECTED', 422, 'File rejected'],
      ['SCAN_UNAVAILABLE', 503, 'File scanning temporarily unavailable'],
    ] as const satisfies readonly (readonly [ProblemCode, number, string])[]
  ).map(([code, status, title]) =>
    Object.freeze({ code, status, title, owner: '@strutvane/core' }),
  ),
)

/** Create a registry, pre-filled with {@link BUILTIN_ERRORS} unless `builtin` is false. */
export function createErrorRegistry(options: { readonly builtin?: boolean } = {}): ErrorRegistry {
  const definitions = new Map<string, ErrorDefinition>()
  const registry: ErrorRegistry = {
    register(definition) {
      if (!CODE.test(definition.code)) {
        throw new TypeError(`Error code "${definition.code}" must be SCREAMING_SNAKE_CASE`)
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
      const existing = definitions.get(definition.code)
      if (existing) {
        throw new Error(
          `Error code "${definition.code}" is already registered by ${existing.owner ?? 'another package'}`,
        )
      }
      definitions.set(definition.code, Object.freeze({ ...definition }))
    },
    get: (code) => definitions.get(code),
    list: () => [...definitions.values()].sort((a, b) => a.code.localeCompare(b.code)),
  }
  if (options.builtin !== false) for (const d of BUILTIN_ERRORS) registry.register(d)
  return registry
}
