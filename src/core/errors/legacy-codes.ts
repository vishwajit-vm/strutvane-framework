/**
 * The compatibility window for the uppercase error codes (CONSISTENCY #123).
 *
 * **Why:** every Strutvane code is lowercase `snake_case` from 0.2 on (`not_found`,
 * `validation_failed`), matching the auth package and RFC 9457 practice (CONSISTENCY #68). Before
 * that, the framework, the CLI and devkit used `SCREAMING_SNAKE_CASE` (`NOT_FOUND`). A package or
 * app written against the old names keeps working for the whole 0.2 line:
 *
 * - `new StrutvaneError('NOT_FOUND')` (and every subclass) carries `not_found`;
 * - the error registry finds `NOT_FOUND` as `not_found`, and still accepts an app's own uppercase
 *   code (`INVOICE_ALREADY_PAID`);
 * - each old name prints one Node `DeprecationWarning` (code `STRUTVANE_UPPERCASE_ERROR_CODE`) per
 *   process, naming the new code.
 *
 * The window closes in 0.3: old names then become unknown codes. The upgrade guide lists every
 * rename (the table below is the source of truth).
 *
 * @module
 */
import type { ProblemCode } from '../../contracts/index.ts'

/**
 * An old, uppercase name of a well-known problem code (`'NOT_FOUND'`).
 *
 * @example
 * const old: LegacyProblemCode = 'NOT_FOUND'
 */
export type LegacyProblemCode = Uppercase<ProblemCode>

/**
 * Every code that was renamed to lowercase in 0.2, old name → new name: HTTP problem codes, CLI
 * error codes (the `--json` `error.code`), devkit, container and model-DSL codes.
 *
 * @example
 * LEGACY_ERROR_CODES['VALIDATION_FAILED'] // 'validation_failed'
 */
export const LEGACY_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [
      // HTTP problem codes (RFC-0002 and RFC-0003): what API clients see in `code`.
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'STALE_RECORD',
      'RATE_LIMITED',
      'PAYLOAD_TOO_LARGE',
      'SERVICE_UNAVAILABLE',
      'INTERNAL_ERROR',
      'FILE_TOO_LARGE',
      'TOO_MANY_FILES',
      'FILE_EMPTY',
      'FILE_TYPE_NOT_ALLOWED',
      'FILE_CORRUPT',
      'IMAGE_DIMENSIONS_INVALID',
      'UPLOAD_INCOMPLETE',
      'STORAGE_UNAVAILABLE',
      'QUOTA_EXCEEDED',
      'FILE_INFECTED',
      'SCAN_UNAVAILABLE',
      'TENANT_REQUIRED',
      'RECORD_IN_USE',
      'MALFORMED_REQUEST',
      'UNSUPPORTED_MEDIA_TYPE',
      'METHOD_NOT_ALLOWED',
      // CLI (`node strut … --json` → `error.code`) and devkit.
      'ADDRESS_NOT_AVAILABLE',
      'AMBIGUOUS_COMMAND',
      'BOOT_FAILED',
      'BOOT_TIMEOUT',
      'CASE_CONFLICT',
      'CIRCULAR_DEPENDENCY',
      'COMMAND_FAILED',
      'COMMAND_NOT_FOUND',
      'CONFIG_NOT_FOUND',
      'CONFIG_SHAPE_UNRECOGNISED',
      'CWD_NOT_FOUND',
      'DOCTOR_FAILED',
      'DUPLICATE_COMMAND',
      'DUPLICATE_JOB',
      'DUPLICATE_MODEL',
      'DUPLICATE_PAGE_ROUTE',
      'DUPLICATE_POLICY',
      'DUPLICATE_RESOURCE',
      'DUPLICATE_ROUTE',
      'DUPLICATE_ROUTE_NAME',
      'ENV_EXAMPLE_MISSING',
      'ENV_INVALID',
      'ENV_PROBLEMS',
      'FILE_EXISTS',
      'FILE_NAME_MISMATCH',
      'FILE_NOT_FOUND',
      'FRAMEWORK_COMMAND_MISSING',
      'FRAMEWORK_REQUIRED',
      'GENERATOR_INPUT_INVALID',
      'INCOMPATIBLE_PACKAGE',
      'INCOMPATIBLE_PLUGINS',
      'INPUT_REQUIRED',
      'INSTALLER_FAILED',
      'INTERRUPTED',
      'INTERRUPTED_TRANSACTION',
      'INVALID_ARGUMENT',
      'INVALID_CHOICE',
      'INVALID_CONTRIBUTION',
      'INVALID_ENV_KEY',
      'INVALID_ENV_VALUE',
      'INVALID_FLAG_VALUE',
      'INVALID_GENERATOR',
      'INVALID_INSTALLER',
      'INVALID_MODEL_NAME',
      'INVALID_NAME',
      'INVALID_PACKAGE_JSON',
      'INVALID_PACKAGE_NAME',
      'INVALID_PATH',
      'INVALID_PERMISSION',
      'INVALID_ROUTE',
      'KEY_EXISTS',
      'LOCAL_DEPENDENCY_SPEC',
      'MERGE_CONFLICTS',
      'MISSING_ARGUMENT',
      'MISSING_COMPAT',
      'MISSING_DEFAULT_EXPORT',
      'MODEL_NOT_FOUND',
      'NON_LITERAL_ARGUMENT',
      'NOT_IMPORTED_FROM_FRAMEWORK',
      'OWNED_FILE',
      'PACKAGE_NOT_INSTALLED',
      'PARSE_ERROR',
      'PATH_OUTSIDE_PROJECT',
      'PORT_ACCESS_DENIED',
      'PORT_IN_USE',
      'PRODUCTION_GUARD',
      'PROJECT_INVALID',
      'PROJECT_NOT_FOUND',
      'REGISTRY_ERRORS',
      'REGISTRY_STALE',
      'RESERVED_NAME',
      'SCOPE_REQUIRED',
      'TOO_MANY_ARGUMENTS',
      'TRANSACTION_ABORTED',
      'TYPECHECK_FAILED',
      'UNEXPECTED_DEFAULT_EXPORT',
      'UNINSTALL_NOT_SUPPORTED',
      'UNKNOWN_COMMAND',
      'UNKNOWN_FLAG',
      'UNKNOWN_MODEL',
      'UNSAFE_ARGUMENT',
      'UNSAFE_CONTRIBUTION',
      'UNSAFE_OUTPUT_PATH',
      'WRONG_ARGUMENT_COUNT',
      // Container (`ContainerError.code`).
      'ALREADY_RESOLVED',
      'DISPOSED',
      // Model field DSL parser (`field('string|max:120')` issues).
      'CONFLICTING_MODIFIERS',
      'DUPLICATE_FIELD',
      'DUPLICATE_MODIFIER',
      'EMPTY_ARGUMENT',
      'EMPTY_SEGMENT',
      'EMPTY_SPEC',
      'INVALID_DEFAULT',
      'INVALID_FIELD',
      'MISSING_TYPE',
      'MODIFIER_NOT_APPLICABLE',
      'UNCLOSED_PARENTHESIS',
      'UNEXPECTED_CHARACTER',
      'UNKNOWN_MODIFIER',
      'UNKNOWN_TOKEN',
      'UNKNOWN_TYPE',
      'UNTERMINATED_QUOTE',
      'SUSPICIOUS_FILE_NAME',
    ].map((code) => [code, code.toLowerCase()]),
  ),
)

/** Old names already warned about in this process (one warning each). */
const warned = new Set<string>()

/**
 * The current name of an error code: the lowercase name for a renamed uppercase one (with a
 * one-time deprecation warning), anything else unchanged. App-owned uppercase codes such as
 * `INVOICE_ALREADY_PAID` are left alone; the registry warns about those when they are registered.
 *
 * @example
 * currentErrorCode('NOT_FOUND')     // 'not_found' (and one DeprecationWarning)
 * currentErrorCode('not_found')     // 'not_found'
 * currentErrorCode('invoice_paid')  // 'invoice_paid'
 */
export function currentErrorCode<const TCode extends string>(
  code: TCode,
): TCode extends LegacyProblemCode ? Lowercase<TCode> : string
export function currentErrorCode(code: string): string {
  const renamed = Object.hasOwn(LEGACY_ERROR_CODES, code) ? LEGACY_ERROR_CODES[code] : undefined
  if (renamed === undefined) return code
  warnOnce(
    code,
    `Error code "${code}" was renamed to "${renamed}" in @strutvane/framework 0.2; the old name stops working in 0.3. Use "${renamed}".`,
  )
  return renamed
}

/**
 * Warn once per process that an app registered an uppercase code of its own (still accepted in
 * the 0.2 line).
 *
 * @example
 * warnUppercaseCode('INVOICE_ALREADY_PAID')
 */
export function warnUppercaseCode(code: string): void {
  warnOnce(
    code,
    `Error code "${code}" is uppercase; Strutvane codes are lowercase snake_case from 0.2 ("${code.toLowerCase()}"). Uppercase codes stop being accepted in 0.3.`,
  )
}

function warnOnce(code: string, message: string): void {
  if (warned.has(code)) return
  warned.add(code)
  // A Node DeprecationWarning (not the logger): it reaches the developer once, honours
  // --no-deprecation / --throw-deprecation, and never lands in an app's request logs.
  if (typeof process !== 'undefined' && typeof process.emitWarning === 'function')
    process.emitWarning(message, {
      type: 'DeprecationWarning',
      code: 'STRUTVANE_UPPERCASE_ERROR_CODE',
    })
}
