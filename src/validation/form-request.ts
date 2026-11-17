/**
 * Form requests: Laravel's `StorePostRequest` with `rules()` and `authorize()`, validating with any
 * Standard Schema library (Zod 4 by default).
 *
 * One deliberate change from Laravel: **unknown fields are rejected by default** (Laravel's
 * `#[FailOnUnknownFields]` is opt-in). Sending `is_admin: true` to an endpoint that doesn't accept
 * it is a 422, not a silent no-op that hides a mass-assignment probe or a client typo.
 *
 * Failures are core `ValidationError`s (422 `validation_failed`) whose issues carry the field's
 * `path` in the body (`['title']`, `['lines', 2, 'amount']`), a `code` and the validator's message.
 *
 * @module
 */
import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
} from '../contracts/standard-schema.ts'
import { ForbiddenError, type IssueInput, ValidationError } from '../core/errors/errors.ts'
import type { HttpContext } from '../http/app/context.ts'

/**
 * A Standard Schema validator producing `TOutput` (Zod, Valibot, ArkType…).
 *
 * @example
 * const schema: StandardSchema<{ title: string }> = z.object({ title: z.string() })
 */
export type StandardSchema<TOutput> = StandardSchemaV1<unknown, TOutput>

/**
 * A form request. Subclass it, return a schema from `rules()`, and call `validate(ctx)` in the
 * controller (or let `ResourceController` call it).
 *
 * @example
 * export class StorePostRequest extends FormRequest<{ title: string }> {
 *   rules() { return z.object({ title: z.string().min(3) }) }
 * }
 * const input = await new StorePostRequest().validate(ctx) // { title: string }, or a 422
 */
export abstract class FormRequest<TOutput extends object> {
  /**
   * The validation schema.
   *
   * @example
   * rules() { return z.object({ title: z.string() }) }
   */
  abstract rules(ctx: HttpContext): StandardSchema<TOutput>

  /**
   * Extra request-level permission, Laravel's `authorize()`. Defaults to "yes", because the
   * policy is the main gate; return `false` for a 403.
   *
   * @example
   * authorize(ctx) { return ctx.user !== null }
   */
  authorize(_ctx: HttpContext): boolean | Promise<boolean> {
    return true
  }

  /**
   * Normalise input before validation (trim strings, lower-case emails), Laravel's
   * `prepareForValidation()`.
   *
   * @example
   * prepareForValidation(input) { return { ...input, email: String(input.email).toLowerCase() } }
   */
  prepareForValidation(
    input: Readonly<Record<string, unknown>>,
    _ctx: HttpContext,
  ): Readonly<Record<string, unknown>> {
    return input
  }

  /**
   * Read the JSON body, authorize, normalise and validate it. Every issue is reported at once.
   *
   * @example
   * const input = await new UpdatePostRequest().validate(ctx)
   */
  async validate(ctx: HttpContext): Promise<TOutput> {
    if ((await this.authorize(ctx)) !== true) throw new ForbiddenError()
    const body = await ctx.body()
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new ValidationError([{ path: [], code: 'invalid_body' }])
    const input = this.prepareForValidation(body as Record<string, unknown>, ctx)
    return validateInput(this.rules(ctx), input)
  }
}

/**
 * Validate an object with a schema, refusing keys the schema doesn't produce. Throws a
 * `ValidationError` listing every issue.
 *
 * @example
 * const values = await validateInput(schema, { title: 'Hello' })
 */
export async function validateInput<TOutput extends object>(
  schema: StandardSchema<TOutput>,
  input: Readonly<Record<string, unknown>>,
): Promise<TOutput> {
  const result = await schema['~standard'].validate(input)
  const issues: IssueInput[] = result.issues === undefined ? [] : result.issues.map(toIssue)
  const output = result.issues === undefined ? result.value : undefined
  issues.push(...unknownFields(input, output))
  if (issues.length > 0) throw new ValidationError(issues)
  if (output === undefined || typeof output !== 'object' || output === null)
    throw new ValidationError([{ path: [], code: 'invalid_body' }])
  return output
}

/**
 * Turn a Standard Schema issue into the core issue shape (`path`, `code`, `message`). Zod adds a
 * `code` the standard doesn't define; it is kept when present, else `invalid`.
 *
 * @example
 * toIssue({ message: 'Too short', path: ['title'] }) // { path: ['title'], code: 'invalid', message: 'Too short' }
 */
export function toIssue(issue: StandardSchemaV1Issue): IssueInput {
  const path = (issue.path ?? []).map(segmentKey)
  const raw = (issue as { readonly code?: unknown }).code
  const code = typeof raw === 'string' && /^[a-z][a-z0-9_]*$/.test(raw) ? raw : 'invalid'
  return { path, code, message: issue.message }
}

function segmentKey(segment: PropertyKey | StandardSchemaV1PathSegment): string | number {
  const key = typeof segment === 'object' ? segment.key : segment
  return typeof key === 'number' ? key : String(key)
}

/**
 * Keys the client sent that the schema doesn't produce. Works with any library: a non-strict
 * object schema strips unknown keys, so "sent but not in the output" means "not accepted". When
 * validation failed (no output), the schema's own issues are enough.
 */
function unknownFields(
  input: Readonly<Record<string, unknown>>,
  output: object | undefined,
): IssueInput[] {
  if (output === undefined || typeof output !== 'object' || output === null) return []
  const accepted = new Set(Object.keys(output))
  return Object.keys(input)
    .filter((key) => !accepted.has(key) && input[key] !== undefined)
    .map((key) => ({ path: [key], code: 'unknown_field' }))
}
