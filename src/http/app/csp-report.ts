/**
 * The CSP violation report endpoint (`POST /_strutvane/csp-report`), which the default policy's
 * `report-uri` points at. Each report is logged as a warning through the Logger.
 *
 * Reports are attacker-controllable input (anyone can POST one), so the endpoint is small and
 * strict: 16 KiB at most, a shallow JSON shape, at most 10 violations per request, rate limited,
 * and only *sanitised* fields are logged: the directive, the blocked resource's origin and the
 * document's path. Query strings are dropped because they can carry tokens, and control
 * characters are stripped so a report can't forge extra log lines.
 *
 * @module
 */
import { StrutvaneError } from '../../core/errors/errors.ts'
import { LoggerToken } from '../../core/tokens.ts'
import { currentApplication } from '../../foundation/current.ts'
import { defineRoutes, Route, type RouteList } from '../../routing/route.ts'
import { JsonLimitError, parseJsonSafely } from '../../security/safe-json.ts'
import { CSP_REPORT_PATH } from '../../security/secure-headers.ts'
import { type HttpContext, readLimitedText } from './context.ts'

/**
 * The route name, so tools can recognise the endpoint as public by design.
 *
 * @example
 * route.name === CSP_REPORT_ROUTE
 */
export const CSP_REPORT_ROUTE = 'strutvane.csp-report'

const REPORT_TYPES: ReadonlySet<string> = new Set([
  'application/csp-report',
  'application/reports+json',
  'application/json',
])
const MAX_BYTES = 16 * 1024
const MAX_VIOLATIONS = 10

/**
 * The route, added by the framework. CSRF is explicitly off (browsers send reports without a
 * token, and a report changes no state) and visible as an opt-out in `route:list --security`.
 *
 * @example
 * app.addRoutes(cspReportRoutes())
 */
export function cspReportRoutes(): RouteList<unknown> {
  return defineRoutes([
    Route.post(CSP_REPORT_PATH, handleCspReport)
      .name(CSP_REPORT_ROUTE)
      .middleware('throttle:60,1')
      .withoutMiddleware('csrf'),
  ])
}

/**
 * Log the violations in a report and answer 204.
 *
 * @example
 * Route.post('/csp', handleCspReport)
 */
export async function handleCspReport(ctx: HttpContext): Promise<Response> {
  const type =
    (ctx.request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!REPORT_TYPES.has(type))
    throw new StrutvaneError('unsupported_media_type', {
      status: 415,
      params: { expected: [...REPORT_TYPES].join(' or ') },
    })
  const text = await readLimitedText(ctx.request, MAX_BYTES)
  let parsed: unknown
  try {
    parsed = parseJsonSafely(text, { maxDepth: 6, maxKeys: 300 })
  } catch (error) {
    if (error instanceof JsonLimitError) throw error.toHttpError()
    throw error
  }
  const logger = currentApplication('The CSP report endpoint').container.make(LoggerToken)
  for (const violation of violations(parsed).slice(0, MAX_VIOLATIONS))
    logger.warn('CSP violation', violation)
  return new Response(null, { status: 204 })
}

/** The violations in either report format (the old `csp-report` object, or Reporting API arrays). */
function violations(report: unknown): Record<string, string | number>[] {
  if (Array.isArray(report))
    return report.flatMap((entry) =>
      isRecord(entry) && entry['type'] === 'csp-violation' && isRecord(entry['body'])
        ? [sanitise(entry['body'])]
        : [],
    )
  if (isRecord(report) && isRecord(report['csp-report'])) return [sanitise(report['csp-report'])]
  return []
}

function sanitise(body: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const pick = (...keys: string[]): unknown =>
    keys
      .map((key) => (Object.hasOwn(body, key) ? body[key] : undefined))
      .find((value) => value !== undefined)
  const line = pick('line-number', 'lineNumber')
  return {
    directive: keyword(pick('effective-directive', 'effectiveDirective', 'violated-directive')),
    blocked: originOrKeyword(pick('blocked-uri', 'blockedURL')),
    document: pathOnly(pick('document-uri', 'documentURL')),
    source: pathOnly(pick('source-file', 'sourceFile')),
    ...(typeof line === 'number' && Number.isInteger(line) ? { line } : {}),
  }
}

/** A directive or keyword: lower-case letters and dashes only, else "other". */
function keyword(value: unknown): string {
  return typeof value === 'string' && /^[a-z-]{1,60}$/.test(value) ? value : 'other'
}

/** A URL reduced to its origin (no path or query that could hold a token), or a keyword like `inline`. */
function originOrKeyword(value: unknown): string {
  if (typeof value !== 'string') return 'other'
  if (URL.canParse(value)) {
    const url = new URL(value)
    return url.origin === 'null' ? url.protocol : url.origin
  }
  return keyword(value)
}

/** A URL reduced to its path, capped, without control characters. */
function pathOnly(value: unknown): string {
  if (typeof value !== 'string' || !URL.canParse(value)) return 'other'
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  return new URL(value).pathname.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
