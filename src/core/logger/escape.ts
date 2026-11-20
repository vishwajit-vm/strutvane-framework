/**
 * Characters that must never reach a log file or a terminal raw, and the one escape both log
 * formats (and core's fallback logger) use for them.
 *
 * `JSON.stringify` already escapes CR, LF and every C0 control character (ESC, which starts ANSI
 * colour codes, included). It leaves these raw, so they are escaped here:
 * - **U+2028 / U+2029**: valid in JSON, but some viewers and editors treat them as line breaks, so
 *   a message could appear to start a new record;
 * - **DEL and the C1 controls (U+007F to U+009F)**: U+009B is a one-character ANSI "CSI" in
 *   terminals that honour 8-bit controls;
 * - **bidirectional controls** (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069): the
 *   "Trojan Source" characters. In a terminal or a viewer they reorder what is displayed, so a
 *   logged value could make a line *look* like it says something else (a different user id, an
 *   `ERROR` that reads as `INFO`).
 *
 * The class is written with escape sequences, never literal characters: some editors and tools
 * silently turn a literal U+2028 into a real line break.
 *
 * @module
 */

const BACKSLASH = String.fromCharCode(0x5c)

/**
 * The characters {@link escapeUnsafeText} replaces, as a regular-expression class source (for
 * modules that build a bigger pattern around it).
 */
export const UNSAFE_TEXT_CLASS =
  '\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069'

const UNSAFE_TEST = new RegExp(`[${UNSAFE_TEXT_CLASS}]`)
const UNSAFE_ALL = new RegExp(`[${UNSAFE_TEXT_CLASS}]`, 'g')

/**
 * `\uXXXX` for one UTF-16 code unit: the escape both formats use for characters that must never
 * reach a file or a terminal raw.
 *
 * @example
 * unicodeEscape(String.fromCharCode(0x1b)) // the six characters \u001b
 */
export function unicodeEscape(char: string): string {
  return `${BACKSLASH}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
}

/**
 * Escape the characters listed in the module notes inside already-serialised JSON. They can only
 * occur inside JSON string values (JSON's own syntax is ASCII), so the result is still valid JSON
 * that parses back to the same value.
 *
 * @example
 * escapeUnsafeText(JSON.stringify({ msg: `a${String.fromCharCode(0x202e)}b` })) // the override becomes \u202e
 */
export function escapeUnsafeText(json: string): string {
  if (!UNSAFE_TEST.test(json)) return json
  return json.replace(UNSAFE_ALL, unicodeEscape)
}
