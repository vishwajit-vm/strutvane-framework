/**
 * One check for ASCII control characters (U+0000 to U+001F and U+007F), shared by every place
 * that must keep them out: header values (a CR/LF would start a new header line), signing
 * purposes (a line break separates the parts of the signed message) and redirect targets
 * (browsers silently drop tabs and newlines, turning `/\t/evil.com` into `//evil.com`).
 *
 * A loop rather than a regular expression with control-character ranges, which the linter rightly
 * flags as usually accidental; here it is the whole point.
 *
 * @module
 */

/**
 * `true` when `value` contains an ASCII control character.
 *
 * @example
 * hasControlCharacter('a\r\nb') // true
 * hasControlCharacter('camera=()') // false
 */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
