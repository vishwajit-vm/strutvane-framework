/**
 * Name handling for generators: one input (`InvoiceLine`, `invoice-line`, `invoice_line`) maps to
 * every spelling a generated file needs. All generators derive names here, so a model, its policy,
 * factory, routes and tests always agree.
 *
 * @module
 */
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'

/** Every spelling of a model or class name. */
export interface Names {
  /** `InvoiceLine`: class/model name. */
  readonly pascal: string
  /** `invoiceLine`: resource key (permissions, policies). */
  readonly camel: string
  /** `invoice-line`: file names. */
  readonly kebab: string
  /** `invoice_line`: SQL-ish identifiers. */
  readonly snake: string
  /** `invoice-lines`: URL segments. */
  readonly kebabPlural: string
  /** `invoice_lines`: table names. */
  readonly snakePlural: string
  /** `Invoice line`: human label. */
  readonly label: string
  /** `Invoice lines`. */
  readonly labelPlural: string
}

/** Split any common spelling into lowercase words. */
export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase())
}

const IRREGULAR: Readonly<Record<string, string>> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  mouse: 'mice',
  goose: 'geese',
  datum: 'data',
}
const UNCOUNTABLE = new Set([
  'equipment',
  'information',
  'money',
  'series',
  'species',
  'news',
  'data',
])

/** English plural of one lowercase word (common rules only; irregulars by table). */
export function pluralize(word: string): string {
  if (UNCOUNTABLE.has(word)) return word
  const irregular = IRREGULAR[word]
  if (irregular !== undefined) return irregular
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}

const capital = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)

/** Identifier-ish names: letters first, then letters, digits, `-` or `_`. */
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * Device names Windows reserves in every folder, with or without an extension (`con.model.ts` is
 * still the console). Generated file names derive from the name, so these are refused everywhere:
 * a project must check out on every OS.
 */
export const WINDOWS_RESERVED: RegExp = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * Derive every spelling from `input`. Throws `INVALID_NAME` (exit 3) for names that cannot be a
 * TypeScript identifier and a file name on every OS (including Windows device names).
 */
export function names(input: string, what = 'Name'): Names {
  if (!NAME.test(input)) {
    throw new CliError('INVALID_NAME', {
      exitCode: EXIT.VALIDATION,
      params: {
        detail: `${what} "${input}" must start with a letter and use only letters, digits, "-" or "_".`,
      },
    })
  }
  const parts = words(input)
  const last = parts[parts.length - 1] ?? ''
  const pluralParts = [...parts.slice(0, -1), pluralize(last)]
  const label = capital(parts.join(' '))
  const reserved = [
    parts.join('-'),
    parts.join('_'),
    pluralParts.join('-'),
    pluralParts.join('_'),
  ].filter((file) => WINDOWS_RESERVED.test(file))
  if (reserved.length > 0) {
    throw new CliError('INVALID_NAME', {
      exitCode: EXIT.VALIDATION,
      params: {
        detail: `${what} "${input}" would create a file named "${reserved[0]}", which Windows reserves for a device. Choose another name.`,
      },
    })
  }
  return {
    pascal: parts.map(capital).join(''),
    camel: parts.map((w, i) => (i === 0 ? w : capital(w))).join(''),
    kebab: parts.join('-'),
    snake: parts.join('_'),
    kebabPlural: pluralParts.join('-'),
    snakePlural: pluralParts.join('_'),
    label,
    labelPlural: capital(pluralParts.join(' ')),
  }
}

const LINE_SEPARATOR_2028 = new RegExp(String.fromCharCode(0x2028), 'g')
const LINE_SEPARATOR_2029 = new RegExp(String.fromCharCode(0x2029), 'g')

/**
 * A single-quoted TypeScript string literal (the project style), safe for any input: quotes,
 * backslashes, line breaks and the JavaScript line separators are escaped.
 */
export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(LINE_SEPARATOR_2028, '\\u2028')
    .replace(LINE_SEPARATOR_2029, '\\u2029')
  return `'${escaped}'`
}
