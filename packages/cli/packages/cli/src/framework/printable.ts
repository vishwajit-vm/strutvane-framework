/**
 * Making untrusted text safe to print.
 *
 * Package manifests (versions, `strutvane.compat` ranges) and env files come from files the CLI
 * does not control. Printed as-is, control characters in them (ANSI escape sequences, carriage
 * returns, line breaks) could rewrite what the terminal shows, e.g. hide a warning or fake a
 * success line. Everything such a file contributes to output goes through {@link printable}.
 *
 * @module
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** `text` without C0/C1 control characters, cut to `max` characters (default 200). */
export function printable(text: string, max = 200): string {
  return text.replace(CONTROL, '').slice(0, max)
}
