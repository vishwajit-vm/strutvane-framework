/**
 * Terminal output: human text or a single JSON document, never a mix.
 *
 * Commands write through {@link Output} and never touch `process.stdout` or `console`. That gives
 * three guarantees:
 * - with `--json`, stdout contains exactly one JSON document (the envelope) and nothing else, so
 *   `sv routes --json | jq` always works;
 * - colors are decided once (flag, `NO_COLOR`, `FORCE_COLOR`, TTY) instead of per call site;
 * - tests capture output by passing their own streams.
 *
 * Human results go to stdout; warnings, errors and progress go to stderr, so piping a command's
 * output never captures its diagnostics.
 *
 * @module
 */

/** Where output is written. */
export interface OutputStreams {
  stdout(text: string): void
  stderr(text: string): void
}

/** ANSI styling helpers. Each returns the text unchanged when color is off. */
export interface Style {
  readonly enabled: boolean
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  cyan(text: string): string
}

/** Create a {@link Style}. */
export function createStyle(enabled: boolean): Style {
  const wrap =
    (open: number, close: number) =>
    (text: string): string =>
      enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  }
}

/** Remove ANSI escape sequences (for width calculations and plain logs). */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** Inputs to the color decision. */
export interface ColorDecision {
  /** `--color` / `--no-color` (undefined when neither was passed). */
  readonly flag: boolean | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly isTTY: boolean
}

/**
 * Decide whether to use color: an explicit flag wins, then `NO_COLOR` (https://no-color.org),
 * then `FORCE_COLOR`, then whether stdout is a terminal.
 */
export function shouldUseColor(decision: ColorDecision): boolean {
  if (decision.flag !== undefined) return decision.flag
  const noColor = decision.env['NO_COLOR']
  if (noColor !== undefined && noColor !== '') return false
  const force = decision.env['FORCE_COLOR']
  if (force !== undefined && force !== '') return force !== '0' && force !== 'false'
  return decision.isTTY
}

/** Options for {@link createOutput}. */
export interface OutputOptions {
  readonly json: boolean
  readonly color: boolean
  readonly quiet: boolean
  readonly streams: OutputStreams
}

/** The output channel handed to every command. */
export interface Output {
  /** `true` with `--json`: human output is suppressed and the result is printed as JSON. */
  readonly json: boolean
  readonly style: Style
  /** A plain line on stdout (human mode only; suppressed by `--quiet`). */
  line(text?: string): void
  /** A success line on stdout (human mode only). */
  success(text: string): void
  /** Progress or context on stderr (human mode only; suppressed by `--quiet`). */
  info(text: string): void
  /** A warning: on stderr in human mode, and in the envelope's `warnings` in both modes. */
  warn(text: string): void
  /** An aligned table on stdout (human mode only). */
  table(headers: readonly string[], rows: readonly (readonly string[])[]): void
  /** Write text to stdout exactly as given (human mode only), e.g. a diff. */
  raw(text: string): void
  /** Warnings collected so far. */
  readonly warnings: readonly string[]
}

/** Create an {@link Output}. */
export function createOutput(options: OutputOptions): Output {
  const style = createStyle(options.color && !options.json)
  const warnings: string[] = []
  const human = !options.json
  const loud = human && !options.quiet
  const out = (text: string): void => options.streams.stdout(`${text}\n`)
  const err = (text: string): void => options.streams.stderr(`${text}\n`)

  return {
    json: options.json,
    style,
    warnings,
    line(text = '') {
      if (loud) out(text)
    },
    success(text) {
      if (human) out(`${style.green('✔')} ${text}`)
    },
    info(text) {
      if (loud) err(style.dim(text))
    },
    warn(text) {
      warnings.push(text)
      if (human) err(`${style.yellow('warning:')} ${text}`)
    },
    table(headers, rows) {
      if (!human) return
      for (const line of formatTable(headers, rows, style)) out(line)
    },
    raw(text) {
      if (human) options.streams.stdout(text.endsWith('\n') || text === '' ? text : `${text}\n`)
    },
  }
}

/** Format rows as aligned columns (two spaces apart). Trailing spaces are trimmed. */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  style: Style = createStyle(false),
): string[] {
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)),
  )
  const pad = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell + ' '.repeat(Math.max(0, (widths[i] ?? 0) - stripAnsi(cell).length)))
      .join('  ')
      .trimEnd()
  return [style.bold(pad(headers)), ...rows.map(pad)]
}
