/**
 * The CLI's error model (RFC-0003 applied to a terminal).
 *
 * Commands throw; they never print errors or call `process.exit` themselves. The runner turns
 * every thrown value into one {@link CliFailure} (stable code, catalog message, optional hint and
 * issues, exit code) and renders it the same way for every command, in text or `--json`. That is
 * what makes exit codes and the JSON schema dependable for CI.
 *
 * @module
 */
import type { IssueParam } from '../../contracts/index.ts'
import { type ErrorParams, StrutvaneError, ValidationError } from '../../core/index.ts'
import { EXIT, type ExitCode } from './exit-codes.ts'

/** One problem in a list (a field, a file, an env key), shaped like an RFC-0003 issue. */
export interface CliIssue {
  /** Where the problem is: a field path, a file path, an env key. Empty for general problems. */
  readonly path: readonly (string | number)[]
  /** A stable code for the problem, when one exists. */
  readonly code?: string
  readonly message: string
}

/** Options for {@link CliError}. */
export interface CliErrorOptions {
  readonly exitCode?: ExitCode
  readonly params?: ErrorParams
  readonly issues?: readonly CliIssue[]
  readonly cause?: unknown
  /** Partial results to include in the `--json` envelope (e.g. the checks `doctor` ran). */
  readonly data?: unknown
}

/**
 * An expected failure with a stable code. The message comes from the CLI catalog
 * (`cli.error.<code>`), rendered with `params`.
 */
export class CliError extends StrutvaneError {
  readonly exitCode: ExitCode
  readonly issues: readonly CliIssue[]
  readonly data: unknown

  constructor(code: string, options: CliErrorOptions = {}) {
    super(code, {
      ...(options.params === undefined ? {} : { params: options.params }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    })
    this.exitCode = options.exitCode ?? EXIT.FAILURE
    this.issues = Object.freeze([...(options.issues ?? [])])
    this.data = options.data
  }
}

/** Invalid usage (exit 2). */
export function usageError(code: string, params: ErrorParams = {}): CliError {
  return new CliError(code, { exitCode: EXIT.USAGE, params })
}

/** A normalised failure, ready to render. */
export interface CliFailure {
  readonly code: string
  readonly exitCode: ExitCode
  readonly params: ErrorParams
  readonly issues: readonly CliIssue[]
  /** The original error, for `--verbose` stack traces. */
  readonly error: unknown
  /** `true` when this was not an expected failure (a bug, or an unknown error from a plugin). */
  readonly unexpected: boolean
  /** Partial results for the `--json` envelope. */
  readonly data?: unknown
}

/**
 * Devkit error codes and their exit codes. Matched by `code` rather than `instanceof`, because a
 * plugin's installer may bundle its own copy of devkit, whose classes are different objects.
 */
const DEVKIT_EXIT: Readonly<Record<string, ExitCode>> = {
  PATH_OUTSIDE_PROJECT: EXIT.VALIDATION,
  INVALID_PATH: EXIT.VALIDATION,
  FILE_EXISTS: EXIT.CONFLICT,
  FILE_NOT_FOUND: EXIT.FAILURE,
  INVALID_ENV_KEY: EXIT.VALIDATION,
  INVALID_ENV_VALUE: EXIT.VALIDATION,
  INVALID_PACKAGE_JSON: EXIT.VALIDATION,
  LOCAL_DEPENDENCY_SPEC: EXIT.VALIDATION,
  CONFIG_NOT_FOUND: EXIT.VALIDATION,
  CONFIG_SHAPE_UNRECOGNISED: EXIT.VALIDATION,
  INVALID_INSTALLER: EXIT.FAILURE,
  INSTALLER_FAILED: EXIT.FAILURE,
  UNINSTALL_NOT_SUPPORTED: EXIT.FAILURE,
  INVALID_GENERATOR: EXIT.FAILURE,
  GENERATOR_INPUT_INVALID: EXIT.VALIDATION,
  TRANSACTION_ABORTED: EXIT.FAILURE,
  INTERRUPTED_TRANSACTION: EXIT.FAILURE,
  // Not devkit's, but matched the same way: the registry compiler refusing to write via a link.
  UNSAFE_OUTPUT_PATH: EXIT.VALIDATION,
  // The framework's: a project file that cannot be loaded, and a boot that never finished.
  PROJECT_INVALID: EXIT.VALIDATION,
  BOOT_TIMEOUT: EXIT.FAILURE,
}

/**
 * The framework's `ServerListenError` codes (`sv dev` / `sv start` could not bind its address).
 * A taken or forbidden port is the user's configuration, not a bug: exit with the config code and
 * name the host, the port and how to change them. Matched by `code` plus the documented `host` and
 * `port` fields, never with `instanceof` (the framework is loaded from the project).
 */
const LISTEN_CODES: ReadonlySet<string> = new Set([
  'PORT_IN_USE',
  'PORT_ACCESS_DENIED',
  'ADDRESS_NOT_AVAILABLE',
])

/** The listen-error shape the CLI relies on. */
interface ListenErrorLike extends Error {
  readonly code: string
  readonly host: string
  readonly port: number
}

function isListenError(value: unknown): value is ListenErrorLike {
  return (
    value instanceof Error &&
    'code' in value &&
    typeof value.code === 'string' &&
    LISTEN_CODES.has(value.code) &&
    'host' in value &&
    typeof value.host === 'string' &&
    'port' in value &&
    typeof value.port === 'number'
  )
}

function isIssueList(value: unknown): value is readonly { path: unknown; message: unknown }[] {
  return Array.isArray(value)
}

/** Copy issues from an unknown error, keeping only well-formed entries. */
function issuesOf(value: unknown): CliIssue[] {
  if (!isIssueList(value)) return []
  const out: CliIssue[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const path = Array.isArray(item.path)
      ? item.path.filter(
          (p): p is string | number => typeof p === 'string' || typeof p === 'number',
        )
      : []
    const code = 'code' in item && typeof item.code === 'string' ? item.code : undefined
    const message = typeof item.message === 'string' ? item.message : (code ?? 'Invalid value')
    out.push(code === undefined ? { path, message } : { path, code, message })
  }
  return out
}

/** The shape of core's `EnvValidationError` that the CLI relies on. */
interface EnvValidationLike extends Error {
  readonly problems: readonly unknown[]
}

/**
 * `true` for core's `EnvValidationError` (thrown by `defineEnv` when the app's `.env` does not match
 * its schema). Matched structurally, by the stable `name` core sets plus its documented `problems`
 * list, rather than with `instanceof`: a contributed command may bundle its own copy of core, whose
 * class is a different object. Never by message text.
 */
function isEnvValidationError(value: unknown): value is EnvValidationLike {
  return (
    value instanceof Error &&
    value.name === 'EnvValidationError' &&
    'problems' in value &&
    Array.isArray(value.problems)
  )
}

/**
 * Find an env validation error in `error` or its `cause` chain. Loading an app wraps failures
 * (core's `ProviderError` keeps the original as `cause`), and an invalid `.env` is still a
 * configuration error when it arrives wrapped. Bounded and cycle-safe.
 */
function findEnvValidationError(error: unknown): EnvValidationLike | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < 8 && current instanceof Error && !seen.has(current); depth++) {
    if (isEnvValidationError(current)) return current
    seen.add(current)
    current = current.cause
  }
  return undefined
}

/** One env problem as an issue keyed by the variable name. Never includes the value (core's rule). */
function envIssues(problems: readonly unknown[]): CliIssue[] {
  const out: CliIssue[] = []
  for (const item of problems) {
    if (typeof item !== 'object' || item === null) continue
    const key = 'key' in item && typeof item.key === 'string' ? item.key : ''
    const message = 'message' in item && typeof item.message === 'string' ? item.message : 'Invalid'
    out.push({ path: key === '' ? [] : [key], message })
  }
  return out
}

function stringParams(params: ErrorParams, extra: Record<string, IssueParam>): ErrorParams {
  return { ...params, ...extra }
}

/**
 * `true` for core's `ProviderError` raised while a provider booted: a service the app needs at
 * startup (database, cache, mail) failed. That is the environment, not a bug. Matched by the stable
 * `name` and the documented `phase` and `provider` fields, never with `instanceof` (core may be
 * loaded from the project).
 */
function isBootFailure(value: unknown): value is Error & { readonly provider: string } {
  return (
    value instanceof Error &&
    value.name === 'ProviderError' &&
    'phase' in value &&
    value.phase === 'boot' &&
    'provider' in value &&
    typeof value.provider === 'string'
  )
}

/** Normalise anything thrown into a {@link CliFailure}. Never throws. */
export function toFailure(error: unknown): CliFailure {
  if (error instanceof CliError) {
    return {
      code: error.code,
      exitCode: error.exitCode,
      params: error.params,
      issues: error.issues,
      error,
      unexpected: false,
      ...(error.data === undefined ? {} : { data: error.data }),
    }
  }
  // An invalid .env is the user's configuration, not a bug: list the problems and how to fix them,
  // without the "report the bug" hint, and exit with the validation code (docs/09 §1.4: config, env).
  const envError = findEnvValidationError(error)
  if (envError !== undefined) {
    const issues = envIssues(envError.problems)
    return {
      code: 'ENV_INVALID',
      exitCode: EXIT.VALIDATION,
      params: { count: issues.length },
      issues,
      error,
      unexpected: false,
    }
  }
  if (isListenError(error)) {
    return {
      code: error.code,
      exitCode: EXIT.VALIDATION,
      // Strings, so the catalog never formats a port as "3,000".
      params: { host: error.host, port: String(error.port), detail: error.message },
      issues: [],
      error,
      unexpected: false,
    }
  }
  if (isBootFailure(error)) {
    return {
      code: 'BOOT_FAILED',
      exitCode: EXIT.FAILURE,
      params: { provider: error.provider, detail: error.message },
      issues: [],
      error,
      unexpected: false,
    }
  }
  if (error instanceof ValidationError) {
    return {
      code: 'VALIDATION_FAILED',
      exitCode: EXIT.VALIDATION,
      params: {},
      issues: issuesOf(error.issues),
      error,
      unexpected: false,
    }
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const exitCode = DEVKIT_EXIT[error.code]
    if (exitCode !== undefined) {
      return {
        code: error.code,
        exitCode,
        params: { detail: error.message },
        issues: 'issues' in error ? issuesOf(error.issues) : [],
        error,
        unexpected: false,
      }
    }
    if (error instanceof StrutvaneError) {
      return {
        code: error.code,
        exitCode: EXIT.FAILURE,
        params: stringParams(error.params, { detail: error.message }),
        issues: 'issues' in error ? issuesOf(error.issues) : [],
        error,
        unexpected: false,
      }
    }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return {
    code: 'INTERNAL_ERROR',
    exitCode: EXIT.FAILURE,
    params: { detail },
    issues: [],
    error,
    unexpected: true,
  }
}
