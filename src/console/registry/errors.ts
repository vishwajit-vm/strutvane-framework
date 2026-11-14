/**
 * Structured diagnostics, shaped like RFC-0003 issues: a stable `code`, a human `message`, the
 * place (`file:line:column`), and a `hint` that tells the developer how to fix it.
 *
 * The compiler collects ALL diagnostics in one run (never just the first), so a developer fixes
 * everything in one pass.
 */

export type Severity = 'error' | 'warning'

/** Every diagnostic the registry compiler can produce. Stable: docs and tests rely on them. */
export type DiagnosticCode =
  | 'PARSE_ERROR'
  | 'MISSING_DEFAULT_EXPORT'
  | 'UNEXPECTED_DEFAULT_EXPORT'
  | 'NOT_IMPORTED_FROM_FRAMEWORK'
  | 'NON_LITERAL_ARGUMENT'
  | 'INVALID_MODEL_NAME'
  | 'FILE_NAME_MISMATCH'
  | 'DUPLICATE_MODEL'
  | 'DUPLICATE_RESOURCE'
  | 'DUPLICATE_POLICY'
  | 'UNKNOWN_MODEL'
  | 'INVALID_PERMISSION'
  | 'INVALID_ROUTE'
  | 'DUPLICATE_ROUTE'
  | 'DUPLICATE_ROUTE_NAME'
  | 'DUPLICATE_JOB'
  | 'DUPLICATE_COMMAND'
  | 'DUPLICATE_PAGE_ROUTE'
  | 'CASE_CONFLICT'
  | 'SUSPICIOUS_FILE_NAME'

export interface Diagnostic {
  readonly code: DiagnosticCode
  readonly severity: Severity
  readonly message: string
  /** Project-relative POSIX path. */
  readonly file: string
  /** 1-based line. */
  readonly line: number
  /** 1-based column (UTF-16 code units, matching editors). */
  readonly column: number
  /** How to fix it. */
  readonly hint?: string
}

/** Convert a UTF-16 offset to a 1-based line/column. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let lineStart = 0
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: clamped - lineStart + 1 }
}

/** Build a diagnostic at a source offset. */
export function diagnosticAt(
  code: DiagnosticCode,
  severity: Severity,
  file: string,
  text: string,
  offset: number,
  message: string,
  hint?: string,
): Diagnostic {
  const { line, column } = lineColumn(text, offset)
  return hint === undefined
    ? { code, severity, message, file, line, column }
    : { code, severity, message, file, line, column, hint }
}

/** Diagnostic for a whole file (no meaningful position). */
export function diagnosticForFile(
  code: DiagnosticCode,
  severity: Severity,
  file: string,
  message: string,
  hint?: string,
): Diagnostic {
  return hint === undefined
    ? { code, severity, message, file, line: 1, column: 1 }
    : { code, severity, message, file, line: 1, column: 1, hint }
}

/** `app/models/x.model.ts:3:16 error DUPLICATE_MODEL Model "X" …\n  hint: …` */
export function formatDiagnostic(d: Diagnostic): string {
  const head = `${d.file}:${d.line}:${d.column} ${d.severity} ${d.code} ${d.message}`
  return d.hint === undefined ? head : `${head}\n  hint: ${d.hint}`
}

/** Deterministic ordering: by file, then position, then code. */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  if (a.column !== b.column) return a.column - b.column
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error')
}
