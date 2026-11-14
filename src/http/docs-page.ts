/**
 * `GET /docs`: a readable page for the app's OpenAPI document (docs/05 §1 promises "API docs on
 * :3000/docs"), served next to `/openapi.json` under the same visibility rule.
 *
 * Why server-rendered HTML with no script at all: a docs UI from a CDN would need a page CSP that
 * allows third-party scripts on the API's origin, and an inline renderer would need
 * `'unsafe-inline'` scripts. This page needs neither: its CSP allows only inline styles, every
 * value from the document is HTML-escaped (model names, descriptions and enum values come from
 * app code and must never become markup), and it links to `/openapi.json` for tools such as
 * Postman or a generated client.
 *
 * @module
 */

/** CSP for the docs page: no scripts, no external resources, inline styles only. */
export const DOCS_PAGE_CSP: string =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

/** Escape text for HTML element content and double-quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** `#/components/schemas/Invoice` → `Invoice`; inline schemas by their `type`. */
function schemaName(schema: unknown): string {
  if (!isObject(schema)) return ''
  const ref = text(schema['$ref'])
  if (ref) return ref.split('/').pop() ?? ref
  if (schema['type'] === 'array') return `${schemaName(schema['items'])}[]`
  return text(schema['type']) ?? 'object'
}

interface Operation {
  readonly method: string
  readonly path: string
  readonly op: Json
}

function operations(doc: Json): Operation[] {
  const out: Operation[] = []
  const paths = isObject(doc['paths']) ? doc['paths'] : {}
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue
    for (const method of METHODS) {
      const op = item[method]
      if (isObject(op)) out.push({ method, path, op })
    }
  }
  return out
}

function renderOperation({ method, path, op }: Operation): string {
  const params = Array.isArray(op['parameters']) ? op['parameters'].filter(isObject) : []
  const rows = params
    .map(
      (p) =>
        `<tr><td><code>${escapeHtml(p['name'])}</code></td><td>${escapeHtml(p['in'])}</td>` +
        `<td>${p['required'] === true ? 'yes' : ''}</td><td>${escapeHtml(schemaName(p['schema']))}</td>` +
        `<td>${escapeHtml(text(p['description']) ?? '')}</td></tr>`,
    )
    .join('')
  const body = isObject(op['requestBody']) ? op['requestBody'] : undefined
  const content = body && isObject(body['content']) ? body['content'] : {}
  const bodies = Object.entries(content)
    .map(([type, media]) => {
      const name = isObject(media) ? schemaName(media['schema']) : ''
      return `<code>${escapeHtml(type)}</code>${name ? ` ${escapeHtml(name)}` : ''}`
    })
    .join(', ')
  const responses = isObject(op['responses']) ? Object.keys(op['responses']) : []
  const summary = text(op['summary']) ?? text(op['operationId']) ?? ''
  const description = text(op['description'])
  return [
    `<details><summary><span class="m m-${method}">${method.toUpperCase()}</span> <code>${escapeHtml(path)}</code> ${escapeHtml(summary)}</summary>`,
    description ? `<p>${escapeHtml(description)}</p>` : '',
    rows
      ? `<table><thead><tr><th>Parameter</th><th>In</th><th>Required</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`
      : '',
    bodies ? `<p>Body: ${bodies}</p>` : '',
    responses.length > 0
      ? `<p>Responses: ${responses.map((r) => `<code>${escapeHtml(r)}</code>`).join(' ')}</p>`
      : '',
    '</details>',
  ].join('')
}

/**
 * Render the docs page for an OpenAPI document. Operations are grouped by their first tag (or
 * "Other"), in document order. Reads the document defensively: missing or odd parts are skipped,
 * never thrown on.
 */
export function renderDocsPage(
  document: unknown,
  options: { readonly specUrl?: string } = {},
): string {
  const doc = isObject(document) ? document : {}
  const info = isObject(doc['info']) ? doc['info'] : {}
  const title = text(info['title']) ?? 'API'
  const version = text(info['version'])
  const groups = new Map<string, Operation[]>()
  for (const operation of operations(doc)) {
    const tags = Array.isArray(operation.op['tags']) ? operation.op['tags'] : []
    const tag = text(tags[0]) ?? 'Other'
    const list = groups.get(tag) ?? []
    list.push(operation)
    groups.set(tag, list)
  }
  const sections = [...groups]
    .map(
      ([tag, ops]) =>
        `<section><h2>${escapeHtml(tag)}</h2>${ops.map((o) => renderOperation(o)).join('')}</section>`,
    )
    .join('')
  const spec = options.specUrl ?? '/openapi.json'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} API docs</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:960px;padding:24px 16px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}th,td{border-color:#30363d!important}}
h1{margin:0 0 4px}h2{margin:32px 0 8px;font-size:18px}code{font:13px ui-monospace,monospace}
details{border:1px solid #8884;border-radius:6px;margin:6px 0;padding:6px 10px}summary{cursor:pointer}
table{border-collapse:collapse;margin:8px 0;width:100%}th,td{border:1px solid #d0d7de;padding:4px 6px;text-align:left;font-size:13px}
.m{display:inline-block;min-width:56px;font:600 12px ui-monospace,monospace}
.m-get{color:#1a7f37}.m-post{color:#0969da}.m-patch,.m-put{color:#9a6700}.m-delete{color:#cf222e}
</style></head>
<body><h1>${escapeHtml(title)}</h1>
<p>${version ? `Version ${escapeHtml(version)} · ` : ''}OpenAPI document: <a href="${escapeHtml(spec)}">${escapeHtml(spec)}</a></p>
${sections || '<p>No operations.</p>'}
</body></html>
`
}
