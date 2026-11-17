/**
 * Every error code the framework's own source throws is lowercase `snake_case` (CONSISTENCY #123).
 *
 * Why a source scan: through the 0.2 line an uppercase code still works at run time (StrutvaneError
 * maps it and prints a DeprecationWarning), so a behaviour test cannot tell that the source used an
 * old name. The v2 merge found one that way (`usageError('INVALID_ARGUMENT', …)` in
 * `make:migration`). This test covers the whole class: the first argument of every `new …Error(…)`
 * and `usageError(…)` that is a bare identifier, and every `code: '…'` member.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = join(import.meta.dirname, '../../src')

/** The file that lists the old names on purpose. */
const LEGACY_TABLE = join('core', 'errors', 'legacy-codes.ts')

const CODE_SITES: readonly RegExp[] = [
  /\b(?:new\s+[A-Z]\w*Error|usageError)\(\s*['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g,
  /\bcode:\s*['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g,
]

/** `[file, code]` for every code literal in `src`, outside the legacy table. */
function codeLiterals(): Array<readonly [string, string]> {
  const found: Array<readonly [string, string]> = []
  for (const file of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts') || file === LEGACY_TABLE) continue
    const text = readFileSync(join(SRC, file), 'utf8')
    for (const pattern of CODE_SITES)
      for (const match of text.matchAll(pattern)) {
        const code = match[1]
        if (code !== undefined) found.push([file, code])
      }
  }
  return found
}

describe('error codes in the source (CONSISTENCY #123)', () => {
  test('every thrown code and every code member is lowercase snake_case', () => {
    const literals = codeLiterals()
    // Guard against a scan that silently matches nothing (a moved src folder, a broken pattern).
    expect(literals.length).toBeGreaterThan(100)
    const uppercase = literals.filter(([, code]) => !/^[a-z][a-z0-9_]*$/.test(code))
    expect(uppercase).toEqual([])
  })

  test('the scan sees the shapes it guards against', () => {
    const sample = [
      "throw usageError('INVALID_ARGUMENT', { detail })",
      "new CliError('MODEL_NOT_FOUND', {})",
      "{ path: ['--tenant'], code: 'TENANT_REQUIRED' }",
    ].join('\n')
    const codes = CODE_SITES.flatMap((pattern) =>
      [...sample.matchAll(pattern)].map((match) => match[1]),
    )
    expect(codes.sort()).toEqual(['INVALID_ARGUMENT', 'MODEL_NOT_FOUND', 'TENANT_REQUIRED'])
  })
})
