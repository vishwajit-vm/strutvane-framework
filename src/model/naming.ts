/**
 * Naming rules shared by every layer: model names → tables, field keys → columns, API paths and
 * permission prefixes. Centralised so the schema compiler, migrations, repository, HTTP routes and
 * OpenAPI can never disagree about a name.
 *
 * @module
 */

/** `InvoiceLine` → `invoice_line`, `dueDate` → `due_date`. */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/** `InvoiceLine` → `invoiceLine` (used for permission prefixes: `invoiceLine.create`). */
export function lowerCamel(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1)
}

/** `invoice_line` → `invoice-line` (used for API paths). */
export function kebabCase(value: string): string {
  return snakeCase(value).replaceAll('_', '-')
}

/**
 * Simple English pluralisation for table names and API paths: `category` → `categories`,
 * `box` → `boxes`, `invoice` → `invoices`. Irregular nouns can be set explicitly with the
 * model's `table` option.
 */
export function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}

/** `dueDate` → `Due date`. Used as the default human label of a field. */
export function humanLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Columns every table may have that fields can never use. */
export const RESERVED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'tenant_id',
  'created_at',
  'updated_at',
  'deleted_at',
])

/** Model names are PascalCase identifiers (`Invoice`, `InvoiceLine`). */
export const MODEL_NAME_PATTERN: RegExp = /^[A-Z][A-Za-z0-9]*$/

/** Field keys are lowerCamel identifiers (`dueDate`, `vatNumber`). */
export const FIELD_KEY_PATTERN: RegExp = /^[a-z][A-Za-z0-9]*$/
