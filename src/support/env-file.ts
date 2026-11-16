/**
 * Safe `.env` editing for `node strut key:rotate` (and anything else that changes a few keys):
 * change some variables, keep every other line (comments, order, blank lines, a byte-order mark,
 * CRLF line endings) exactly as it was.
 *
 * Why so careful (spike 12 security review F-17): a value containing a newline would inject a
 * second variable (`APP_DEBUG=true`), and an unquoted `#` silently truncates a value. Values are
 * refused when they hold CR, LF or NUL, and quoted when they contain anything beyond a safe set.
 * Reading uses Node's own parser (`util.parseEnv`), the one the app's env loader uses, so a value
 * is read here exactly as the app will read it.
 *
 * @module
 */
import { parseEnv } from 'node:util'
import { BootError } from '../foundation/boot-error.ts'

/** Values written without quotes: keys, base64, URLs without spaces. */
const UNQUOTED = /^[A-Za-z0-9_+/=:.,@-]*$/
/** Variable names this module writes (upper-case, like every framework variable). */
const KEY = /^[A-Z][A-Z0-9_]*$/

/**
 * Format one value for a `.env` line, quoting it when needed.
 *
 * @example
 * formatEnvValue('base64:abc=') // 'base64:abc='
 * formatEnvValue('two words')   // "'two words'"
 */
export function formatEnvValue(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new BootError(
      'unsafe_env_value',
      'A .env value may not contain line breaks or NUL characters.',
      'Line breaks would let one value inject another variable; remove them.',
    )
  if (UNQUOTED.test(value)) return value
  // Single quotes are literal in Node's parser (no escapes, no expansion), so prefer them.
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"') && !value.includes('\\')) return `"${value}"`
  throw new BootError(
    'unsafe_env_value',
    'This .env value mixes quote characters and cannot be written safely.',
    'Remove either the single or the double quotes from the value.',
  )
}

/**
 * Set variables in `.env` text. Every existing `KEY=` line (an `export ` prefix and a leading
 * byte-order mark are kept) is replaced in place, so no stale duplicate is left for a loader to
 * pick up; a missing key is appended. The file's line ending (LF or CRLF) is kept.
 *
 * @example
 * setEnvValues('APP_NAME=Blog\nAPP_KEY=\n', { APP_KEY: 'base64:…' }) // 'APP_NAME=Blog\nAPP_KEY=base64:…\n'
 */
export function setEnvValues(text: string, values: Readonly<Record<string, string>>): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  for (const [key, value] of Object.entries(values)) {
    if (!KEY.test(key))
      throw new BootError(
        'unsafe_env_key',
        `"${key}" is not a valid .env variable name.`,
        'Use upper-case letters, digits and underscores, starting with a letter.',
      )
    const formatted = formatEnvValue(value)
    const line = new RegExp(`^(\\uFEFF?[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=)`)
    let found = false
    for (const [index, existing] of lines.entries()) {
      const match = line.exec(existing)
      if (match === null) continue
      lines[index] = `${match[1] ?? `${key}=`}${formatted}`
      found = true
    }
    if (!found) lines.push(`${key}=${formatted}`)
  }
  return `${lines.join(eol)}${eol}`
}

/**
 * Read one variable from `.env` text with Node's parser (the app's). Empty counts as unset.
 *
 * @example
 * readEnvValue('APP_KEY=abc\n', 'APP_KEY') // 'abc'
 * readEnvValue('APP_KEY=\n', 'APP_KEY')    // undefined
 */
export function readEnvValue(text: string, key: string): string | undefined {
  const value = parseEnv(text.replace(/^﻿/, ''))[key]
  return value === undefined || value === '' ? undefined : value
}
