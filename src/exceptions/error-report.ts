/**
 * Everything the developer error page shows, gathered once and **redacted once**, so the HTML
 * page, the "Copy as Markdown for AI" text and the JSON `debug` member can never disagree about
 * what is hidden.
 *
 * What is redacted (security review F-19):
 * - header and query values whose *name* is sensitive, by the logger's own matcher
 *   (`sensitiveKeyMatcher` in `core/logger/serialize.ts`: `authorization`, `cookie`, `set-cookie`,
 *   `x-api-key`, `*token*`, `*secret*`, `*password*`, `*signature*`, `*csrf*`, `*session*` …),
 *   plus `key` anywhere and the OAuth words `code` and `state`;
 * - header values that *look* like credentials whatever their name (`Bearer …`, `Basic …`, JWTs);
 * - passwords in URLs (`postgres://user:secret@db`) and JWTs inside the error message.
 *
 * What is never included: the request body (it is not read at all), the host's environment
 * variables, and source files outside the app (see `code-frame.ts`). Long values are cut, so a
 * 10 MB exception message cannot turn the page into a 10 MB response.
 *
 * @module
 */
import {
  DEFAULT_SENSITIVE_KEYS,
  DEFAULT_SENSITIVE_WORDS,
  REDACTED,
  sensitiveKeyMatcher,
} from '../core/logger/serialize.ts'
import { isBootError } from '../foundation/boot-error.ts'
import type { ExceptionRequestInfo } from '../http/app/errors.ts'
import {
  appRelative,
  type CodeFrame,
  codeFrame,
  FRAMEWORK_SOURCE,
  type SplitFrames,
  splitFrames,
  stackFrames,
} from './code-frame.ts'

/**
 * One app frame on the page, with its source for the first few.
 *
 * @example
 * const frame: ReportFrame = { file: 'app/http/controllers/post.controller.ts', line: 7, column: 11, functionName: 'PostController.show', code: undefined }
 */
export interface ReportFrame {
  /** Relative to the app root, forward slashes. */
  readonly file: string
  readonly line: number
  readonly column: number
  readonly functionName: string
  /** The lines around it (the first {@link MAX_CODE_FRAMES} frames only). */
  readonly code: CodeFrame | undefined
}

/**
 * The redacted report behind the debug page, its Markdown and the JSON `debug` member.
 *
 * @example
 * const report = buildReport(error, info, { basePath: '/srv/blog', environment: 'local' })
 */
export interface ErrorReport {
  /** The error's class name (`TypeError`, `BootError`). */
  readonly exception: string
  /** The message, redacted and cut to a sane length. */
  readonly message: string
  /** A `BootError`'s or `StrutvaneError`'s code. */
  readonly code: string | undefined
  /** A `BootError`'s fix-it hint. */
  readonly hint: string | undefined
  /** The app frames, innermost first (the first one is where it threw). */
  readonly frames: readonly ReportFrame[]
  /** Frames hidden because they are Node, a dependency or the framework. */
  readonly hiddenFrames: number
  readonly request: {
    readonly method: string
    /** Path and query, sensitive query values redacted. */
    readonly path: string
    readonly headers: readonly (readonly [string, string])[]
  }
  readonly route:
    | { readonly name?: string; readonly uri: string; readonly action: string }
    | undefined
  /** The request id: the reference that is also in the log line and the `X-Request-Id` header. */
  readonly requestId: string
  readonly environment: string
  readonly node: string
}

/** How many app frames get their source quoted. */
export const MAX_CODE_FRAMES = 3
/** How many app frames are listed at all. */
export const MAX_FRAMES = 20
/** The longest message the page shows. */
export const MAX_MESSAGE = 4000
const MAX_NAME = 200
const MAX_HEADER_VALUE = 500
const MAX_HEADERS = 60
const MAX_PATH = 2000

const isSensitiveName = sensitiveKeyMatcher([...DEFAULT_SENSITIVE_KEYS, 'key'], {
  words: [...DEFAULT_SENSITIVE_WORDS, 'code', 'state'],
})
const CREDENTIAL_VALUE = /^\s*(?:bearer|basic|digest|token|negotiate|apikey)\s+\S/i
const JWT = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g
const URL_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi

/**
 * Gather the redacted report for an error thrown while handling `info.request`.
 *
 * @example
 * buildReport(new TypeError('x'), info, { basePath: '/srv/blog', environment: 'local' })
 */
export function buildReport(
  error: unknown,
  info: ExceptionRequestInfo,
  context: {
    readonly basePath: string
    readonly environment: string
    readonly frameworkRoot?: string
  },
): ErrorReport {
  const root = context.frameworkRoot ?? FRAMEWORK_SOURCE
  const split: SplitFrames = splitFrames(stackFrames(error), context.basePath, root)
  const frames = split.app.slice(0, MAX_FRAMES).map(
    (frame, index): ReportFrame => ({
      file: appRelative(frame.file, context.basePath),
      line: frame.line,
      column: frame.column,
      functionName: cut(frame.functionName, MAX_NAME),
      code: index < MAX_CODE_FRAMES ? codeFrame(frame, context.basePath, 5, root) : undefined,
    }),
  )
  const code = errorCode(error)
  return {
    exception: cut(error instanceof Error ? error.name : typeof error, MAX_NAME),
    message: redactText(cut(error instanceof Error ? error.message : String(error), MAX_MESSAGE)),
    code,
    hint: isBootError(error) ? redactText(cut(error.hint, MAX_MESSAGE)) : undefined,
    frames,
    hiddenFrames: split.hidden + Math.max(0, split.app.length - MAX_FRAMES),
    request: {
      method: cut(info.request.method, 20),
      path: redactPath(info.request.url),
      headers: redactHeaders(info.request.headers),
    },
    route: info.route,
    requestId: info.requestId,
    environment: context.environment,
    node: process.version,
  }
}

/**
 * Whether a header or query parameter name carries a credential.
 *
 * @example
 * isSensitive('X-Api-Key') // true
 * isSensitive('accept') // false
 */
export function isSensitive(name: string): boolean {
  return isSensitiveName(name)
}

/**
 * The request's path and query, with sensitive query values replaced by `[REDACTED]`.
 *
 * @example
 * redactPath('http://x/reset?token=abc&page=2') // '/reset?token=[REDACTED]&page=2'
 */
export function redactPath(raw: string): string {
  const url = new URL(raw)
  const pairs = [...url.searchParams].map(([name, value]) =>
    isSensitiveName(name) || looksLikeCredential(value)
      ? `${encodeURIComponent(name)}=${REDACTED}`
      : `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
  )
  return cut(pairs.length === 0 ? url.pathname : `${url.pathname}?${pairs.join('&')}`, MAX_PATH)
}

/**
 * The request headers with every credential masked (by name or by the look of the value), at
 * most 60 of them, each value cut to 500 characters.
 *
 * @example
 * redactHeaders(new Headers({ authorization: 'Bearer abc' })) // [['authorization', '[REDACTED]']]
 */
export function redactHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = []
  for (const [name, value] of headers) {
    if (out.length >= MAX_HEADERS) break
    out.push([
      cut(name, MAX_NAME),
      isSensitiveName(name) || looksLikeCredential(value) ? REDACTED : cut(value, MAX_HEADER_VALUE),
    ])
  }
  return out
}

/**
 * Mask credentials that sometimes end up inside error messages: URL passwords
 * (`postgres://app:secret@db`) and JWTs.
 *
 * @example
 * redactText('connect postgres://app:hunter2@db failed') // 'connect postgres://app:[REDACTED]@db failed'
 */
export function redactText(text: string): string {
  return text.replace(URL_PASSWORD, `$1:${REDACTED}@`).replace(JWT, REDACTED)
}

function looksLikeCredential(value: string): boolean {
  return CREDENTIAL_VALUE.test(value) || /^eyJ[\w-]{4,}\.[\w-]{4,}\./.test(value.trim())
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? cut(code, MAX_NAME) : undefined
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text
}
