/**
 * Turning any thrown value into an RFC 9457 `Problem` (RFC-0003 §3, "one error handler").
 *
 * Rules:
 * - A {@link StrutvaneError} becomes a problem with its code, its status, a catalog title and
 *   detail, and structured `issues` (for validation errors).
 * - **Anything else becomes `500 INTERNAL_ERROR` with no internal details.** Exception messages
 *   and stack traces can contain SQL, file paths or secrets; they belong in logs, never in responses.
 *
 * @module
 */
import type { IssueParam, Problem, ValidationIssue } from '@strutvane/contracts'
import { createMessages, type MessageOverrides, type Messages } from '../messages/catalog.ts'
import { type IssueInput, StrutvaneError, ValidationError } from './errors.ts'
import { createErrorRegistry, type ErrorRegistry } from './registry.ts'

/** Options for {@link toProblem}. */
export interface ToProblemOptions {
  readonly messages?: Messages
  readonly registry?: ErrorRegistry
  readonly locale?: string
  readonly traceId?: string
  /** URI of this occurrence, typically the request path. */
  readonly instance?: string
  /** Base URI for `type`. Default `https://strutvane.dev/errors/`. */
  readonly typeBase?: string
  /** Field labels by dotted path (e.g. `{ dueDate: 'Due date' }`), used as `{attribute}`. */
  readonly labels?: Readonly<Record<string, string>>
  /** Field/resource message overrides from the model definition. */
  readonly overrides?: MessageOverrides
}

let defaultMessages: Messages | undefined
let defaultRegistry: ErrorRegistry | undefined

/** Lazily created shared defaults (built-in English messages and codes). */
function sharedMessages(): Messages {
  if (!defaultMessages) defaultMessages = createMessages()
  return defaultMessages
}

function sharedRegistry(): ErrorRegistry {
  if (!defaultRegistry) defaultRegistry = createErrorRegistry()
  return defaultRegistry
}

/** `dueDate` → `Due date`, `customer_id` → `Customer id`. Used when no label is given. */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words[0]?.toUpperCase() + words.slice(1) : key
}

/** `["lines", 2, "amount"]` → `"lines.2.amount"`. */
export function issuePathKey(path: readonly (string | number)[]): string {
  return path.map(String).join('.')
}

function attributeFor(
  path: readonly (string | number)[],
  labels: Readonly<Record<string, string>> | undefined,
): string {
  const key = issuePathKey(path)
  const label = labels?.[key]
  if (label) return label
  const last = [...path].reverse().find((s): s is string => typeof s === 'string')
  return last ? humanize(last) : 'This field'
}

/** Render issues with catalog messages (unless a message was already given). */
export function renderIssues(
  issues: readonly IssueInput[],
  messages: Messages,
  options: Pick<ToProblemOptions, 'locale' | 'labels' | 'overrides'> = {},
): ValidationIssue[] {
  const lookup = {
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  }
  return issues.map((issue) => {
    const params: Record<string, IssueParam> = {
      attribute: attributeFor(issue.path, options.labels),
      ...issue.params,
    }
    const key = `validation.${issue.code}`
    const message =
      issue.message ??
      (messages.has(key, lookup)
        ? messages.format(key, params, lookup)
        : messages.format('validation.invalid', params, lookup))
    return {
      path: [...issue.path],
      code: issue.code,
      ...(issue.params && Object.keys(issue.params).length > 0 ? { params: issue.params } : {}),
      message,
    }
  })
}

/** Group rendered issue messages by dotted path (the `fieldErrors` convenience map). */
export function fieldErrorsFrom(issues: readonly ValidationIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const issue of issues) {
    const key = issuePathKey(issue.path)
    const list = out[key] ?? []
    list.push(issue.message)
    out[key] = list
  }
  return out
}

function typeUri(base: string, code: string): string {
  return `${base}${code.toLowerCase().replaceAll('_', '-')}`
}

/**
 * Convert any thrown value to a safe `Problem`. Never throws: if building the rich problem fails
 * (for example a broken custom catalog), a minimal 500 problem is returned instead.
 */
export function toProblem(error: unknown, options: ToProblemOptions = {}): Problem {
  try {
    return buildProblem(error, options)
  } catch {
    return {
      type: typeUri(options.typeBase ?? 'https://strutvane.dev/errors/', 'INTERNAL_ERROR'),
      title: 'Something went wrong',
      status: 500,
      code: 'INTERNAL_ERROR',
      ...(options.traceId ? { traceId: options.traceId } : {}),
    }
  }
}

function buildProblem(error: unknown, options: ToProblemOptions): Problem {
  const messages = options.messages ?? sharedMessages()
  const registry = options.registry ?? sharedRegistry()
  const typeBase = options.typeBase ?? 'https://strutvane.dev/errors/'
  const lookup = { ...(options.locale ? { locale: options.locale } : {}) }
  const common = {
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
  }

  const known = error instanceof StrutvaneError
  const code = known ? error.code : 'INTERNAL_ERROR'
  const definition = registry.get(code)
  const status = (known ? error.status : undefined) ?? definition?.status ?? 500
  const params = known ? error.params : {}
  const titleKey = `errors.${code}.title`
  const detailKey = `errors.${code}.detail`
  const title = messages.has(titleKey, lookup)
    ? messages.format(titleKey, params, lookup)
    : (definition?.title ?? humanize(code))
  const detail = messages.has(detailKey, lookup)
    ? messages.format(detailKey, params, lookup)
    : undefined

  const base: Problem = {
    type: typeUri(typeBase, code),
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    ...common,
  }
  if (error instanceof ValidationError) {
    const issues = renderIssues(error.issues, messages, options)
    return { ...base, issues, fieldErrors: fieldErrorsFrom(issues) }
  }
  return base
}
