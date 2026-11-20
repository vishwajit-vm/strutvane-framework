/**
 * Turning anything thrown during a request into an RFC 9457 problem (RFC-0003), via core's
 * `toProblem`. Known errors keep their code and status; framework-internal errors (filter,
 * sort, cursor, body) become validation issues at the right `query.*` / `body` path; anything
 * unexpected becomes a 500 with only a reference id, and the details go to the logger.
 *
 * @module
 */
import { PROBLEM_CONTENT_TYPE, type Problem } from '../contracts/index.ts'
import {
  ConflictError,
  type ErrorRegistry,
  type IssueInput,
  type Messages,
  NotFoundError,
  StrutvaneError,
  toProblem,
  ValidationError,
} from '../core/index.ts'
import { ReferenceViolationError, UniqueViolationError } from '../database/orm/constraint-errors.ts'
import {
  CastError,
  MassAssignmentError,
  ModelNotFoundError,
  TenantRequiredError,
} from '../database/orm/errors.ts'
import { FilterError } from '../query/bind.ts'
import { CursorError, SortError } from '../query/sort.ts'

/**
 * Core wraps an error thrown by a hook handler in a `HookError` (`cause` = the original). When
 * the original is a Strutvane error (a handler refusing the request on purpose, e.g. auth's
 * field-level write rule), the client must get THAT problem, not a 500.
 */
function unwrapHookError(error: unknown): unknown {
  let current: unknown = error
  for (
    let depth = 0;
    depth < 5 && current instanceof Error && current.name === 'HookError';
    depth++
  )
    current = current.cause
  return current instanceof StrutvaneError ? current : error
}

/** Map framework-internal errors to the public error model; others pass through unchanged. */
export function normalizeError(raw: unknown, where: 'query' | 'body' = 'query'): unknown {
  const error = unwrapHookError(raw)
  if (error instanceof FilterError) {
    const path: (string | number)[] =
      where === 'query'
        ? [
            'query',
            'filter',
            ...(error.field ? [error.field] : []),
            ...(error.operator ? [error.operator] : []),
          ]
        : ['filter']
    const issue: IssueInput = {
      path,
      code: error.code,
      ...(error.operator ? { params: { operator: error.operator } } : {}),
    }
    return new ValidationError([issue], { cause: error })
  }
  if (error instanceof CursorError) {
    return new ValidationError(
      [
        {
          path: where === 'query' ? ['query', 'page', 'cursor'] : ['page', 'cursor'],
          code: 'invalid_cursor',
        },
      ],
      {
        cause: error,
      },
    )
  }
  const orm = ormProblem(error)
  if (orm !== undefined) return orm
  if (error instanceof SortError) {
    return new ValidationError(
      [
        {
          path: where === 'query' ? ['query', 'sort'] : ['sort'],
          code: 'sort_not_allowed',
          params: { field: error.field },
        },
      ],
      {
        cause: error,
      },
    )
  }
  return error
}

/**
 * The ORM's expected errors as problems (RFC-0003 row 4: "DB unique violations are caught and
 * translated, never leaked as SQL errors"). Only errors a request can cause on purpose are mapped;
 * every other ORM error stays a 500, because it is a bug in the app's code.
 *
 * | ORM error | Problem |
 * |---|---|
 * | `UniqueViolationError` on known columns | 422 `validation_failed`, issue `unique` per column |
 * | `UniqueViolationError`, columns unknown | 409 `conflict` |
 * | `ReferenceViolationError` `missing` | 422, issue `not_found` on the foreign key (409 `conflict` when unnamed) |
 * | `ReferenceViolationError` `in_use` | 409 `record_in_use` |
 * | `ModelNotFoundError` | 404 `not_found` (never 403: it doesn't confirm the row exists) |
 * | `MassAssignmentError` | 422, issue `unknown_field` |
 * | `CastError` | 422, issue `invalid` on the column |
 * | `TenantRequiredError` | 403 `tenant_required` |
 */
function ormProblem(error: unknown): StrutvaneError | undefined {
  const options = { cause: error }
  if (error instanceof UniqueViolationError)
    return error.columns.length === 0
      ? new ConflictError('conflict', undefined, options)
      : new ValidationError(
          error.columns.map((column) => ({ path: [column], code: 'unique' })),
          options,
        )
  if (error instanceof ReferenceViolationError) {
    if (error.kind === 'in_use')
      return new ConflictError('record_in_use', { resource: error.table }, options)
    return error.columns.length === 0
      ? new ConflictError('conflict', undefined, options)
      : new ValidationError(
          error.columns.map((column) => ({ path: [column], code: 'not_found' })),
          options,
        )
  }
  if (error instanceof ModelNotFoundError) return new NotFoundError(undefined, options)
  if (error instanceof MassAssignmentError)
    return new ValidationError([{ path: [error.field], code: 'unknown_field' }], options)
  if (error instanceof CastError)
    return new ValidationError([{ path: [error.column], code: 'invalid' }], options)
  if (error instanceof TenantRequiredError)
    return new StrutvaneError('tenant_required', { status: 403, ...options })
  return undefined
}

/** Options for {@link problemResponse}. */
export interface ProblemOptions {
  readonly messages: Messages
  readonly registry: ErrorRegistry
  readonly locale: string
  readonly traceId: string
  readonly instance?: string
  readonly labels?: Readonly<Record<string, string>>
}

/** Render an error as a problem body. */
export function toProblemBody(error: unknown, options: ProblemOptions): Problem {
  return toProblem(error, {
    messages: options.messages,
    registry: options.registry,
    locale: options.locale,
    traceId: options.traceId,
    ...(options.instance ? { instance: options.instance } : {}),
    ...(options.labels ? { labels: options.labels } : {}),
  })
}

/** A problem+json Response, with any headers the error carries (e.g. `Retry-After`). */
export function problemResponse(problem: Problem, error?: unknown): Response {
  const headers = new Headers({ 'content-type': PROBLEM_CONTENT_TYPE })
  if (error instanceof StrutvaneError)
    for (const [k, v] of Object.entries(error.headers)) headers.set(k, v)
  return new Response(JSON.stringify(problem), { status: problem.status, headers })
}
