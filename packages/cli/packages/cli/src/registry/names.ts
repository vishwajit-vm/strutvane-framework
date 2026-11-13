/**
 * Naming rules shared by analysis, registry building and code generation.
 */

/** Model names are PascalCase identifiers: `Invoice`, `InvoiceLine`. */
export function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name)
}

/** `InvoiceLine` → `invoiceLine` (the resource key used in permissions and policies). */
export function resourceKey(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1)
}

/** `invoice-line.model.ts` → `InvoiceLine` (the model name the file name suggests). */
export function modelNameFromFile(fileName: string, suffix: string): string {
  const base = fileName.slice(0, fileName.length - suffix.length)
  return base
    .split(/[-_.]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Permission strings: `resource.action`, lower camel segments, optional extra segments, or `*`.
 * Examples: `invoice.viewAny`, `report.revenue`, `invoiceLine.forceDelete`.
 */
export function isValidPermission(permission: string): boolean {
  return permission === '*' || /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(permission)
}

/**
 * A JavaScript identifier derived from a file path, e.g.
 * `app/models/invoice-line.model.ts` → `model_invoice_line`.
 */
export function identifierForFile(
  kind: string,
  relPath: string,
  dir: string,
  suffix: string,
): string {
  const inner = relPath.slice(dir.length + 1, relPath.length - suffix.length)
  const safe = inner.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${kind}_${safe.length > 0 ? safe : 'index'}`
}

/**
 * Page file → URL path.
 * - `web/pages/index.tsx` → `/`
 * - `web/pages/invoices/index.tsx` → `/invoices`
 * - `web/pages/invoices/[id]/edit.tsx` → `/invoices/:id/edit`
 * - `web/pages/docs/[...slug].tsx` → `/docs/*`
 * - `web/pages/(admin)/users.tsx` → `/users` (parenthesised folders group files without changing the URL)
 */
export function pageRoute(relPath: string, dir: string, suffix: string): string {
  const inner = relPath.slice(dir.length + 1, relPath.length - suffix.length)
  const segments = inner
    .split('/')
    .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    .map((s) => {
      if (s.startsWith('[...') && s.endsWith(']')) return '*'
      if (s.startsWith('[') && s.endsWith(']')) return `:${s.slice(1, -1)}`
      return s
    })
  if (segments[segments.length - 1] === 'index') segments.pop()
  return `/${segments.join('/')}`
}
