/**
 * Secret-bearing env files: recognising them, and keeping their values out of previews.
 *
 * A dry-run diff is printed to terminals, CI logs and `--json` output. For `.env` files that
 * would show real secrets: values devkit just generated, and (as context lines) values the
 * developer already had. So by default every diff of a secret env file is **redacted**: each
 * `KEY=value` line becomes `KEY=<redacted>`, whether it is added, removed or context, and any
 * other non-comment line (for example the continuation of a multi-line quoted value) becomes
 * `<redacted>`. Comments and blank lines are kept so the preview still shows the shape of the
 * change. Redaction rewrites lines one for one, so hunk headers stay correct.
 *
 * Secret env files are `.env` and `.env.*` (in any folder, any letter case), except
 * `.env.example`, which by design never holds a secret (see `env-editor.ts`).
 *
 * @module
 */
import { formatPatch, structuredPatch } from 'diff'

/** Matches the key part of an env assignment (`KEY=`, `export KEY =`). Group 1 is the key. */
export const ENV_LINE_KEY: RegExp = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

/** What a redacted value is replaced with. */
export const REDACTED = '<redacted>'

/** True for `.env` and `.env.*` files other than `.env.example` (project-relative POSIX path). */
export function isSecretEnvFile(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  return name === '.env' || (name.startsWith('.env.') && name !== '.env.example')
}

/** Redact one line of an env file (see the module documentation). A trailing `\r` is kept. */
export function redactEnvLine(line: string): string {
  const cr = line.endsWith('\r') ? '\r' : ''
  const body = cr === '' ? line : line.slice(0, -1)
  if (/^\s*(?:#|$)/.test(body)) return line
  const key = ENV_LINE_KEY.exec(body)
  return `${key === null ? '' : key[0]}${REDACTED}${cr}`
}

/** Options for {@link unifiedPatch}. */
export interface UnifiedPatchOptions {
  /** Redact the hunks with {@link redactEnvLine} (decided by the caller per file). */
  readonly redact: boolean
  readonly oldHeader?: string
  readonly newHeader?: string
}

/**
 * A unified diff of one file, identical to `diff`'s `createTwoFilesPatch`, with the hunk lines
 * optionally redacted. File names and hunk headers are never redacted.
 */
export function unifiedPatch(
  oldName: string,
  newName: string,
  before: string,
  after: string,
  options: UnifiedPatchOptions,
): string {
  const patch = structuredPatch(
    oldName,
    newName,
    before,
    after,
    options.oldHeader,
    options.newHeader,
  )
  if (options.redact) {
    patch.hunks = patch.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => {
        const marker = line.charAt(0)
        // `\ No newline at end of file` carries no content.
        return marker === '\\' ? line : `${marker}${redactEnvLine(line.slice(1))}`
      }),
    }))
  }
  return formatPatch(patch)
}
