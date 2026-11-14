/**
 * The `.env` ↔ `.env.example` comparison behind `sv env:check` and `sv doctor`.
 *
 * `.env.example` is the documented contract of every variable the app reads (each installer keeps
 * it complete), and `.env` is the local, never-committed copy. Problems:
 * - `missing` (error): in `.env.example` but not in `.env`: the app may fail at boot;
 * - `unknown` (warning, error with `--strict`): in `.env` but not documented;
 * - `empty` (warning, error with `--strict`): defined but empty in `.env`;
 * - `invalid-key` / `invalid-line` (error): not a usable variable assignment;
 * - `duplicate` (warning): defined twice (the last one wins, which hides mistakes);
 * - `secret-in-example` (error): a secret-looking key has a value in `.env.example`, which is
 *   committed; secrets must never be in it.
 *
 * Values are never included in results (they may be secrets); only keys and line numbers are.
 * Malformed lines and invalid keys are reported by `file:line` only, never by their text.
 *
 * @module
 */
import { join } from 'node:path'
import { looksSecret } from '../../devkit/index.ts'
import { ENV_KEY, type EnvFile, readEnvFile } from './env-file.ts'

/** Kinds of env problem. */
export type EnvProblemKind =
  | 'missing'
  | 'unknown'
  | 'empty'
  | 'invalid-key'
  | 'invalid-line'
  | 'duplicate'
  | 'secret-in-example'

/** One problem found by {@link checkEnv}. */
export interface EnvProblem {
  readonly kind: EnvProblemKind
  readonly severity: 'error' | 'warning'
  /**
   * The variable name; for `invalid-line` and `invalid-key` the location `file:line` instead,
   * because the text of a malformed line may be a secret and is never reported.
   */
  readonly key: string
  /** Project-relative file the problem is in. */
  readonly file: string
  readonly line?: number
  readonly message: string
}

/** The result of {@link checkEnv}. */
export interface EnvCheckResult {
  /** Files compared (project-relative). */
  readonly envFiles: readonly string[]
  readonly exampleFile: string
  readonly exampleExists: boolean
  readonly problems: readonly EnvProblem[]
}

/** Options for {@link checkEnv}. */
export interface EnvCheckOptions {
  /** `--env <name>`: `.env.<name>` is layered over `.env`. */
  readonly envName?: string | undefined
  /** Treat unknown and empty keys as errors. */
  readonly strict?: boolean
}

/** Environment names are plain words, so `--env` can never point outside the project. */
const ENV_NAME = /^[A-Za-z0-9_-]+$/

/** Whether an `--env` name is acceptable. */
export function isValidEnvName(name: string): boolean {
  return ENV_NAME.test(name)
}

/** Compare the project's env files. Never includes values in the result. */
export function checkEnv(root: string, options: EnvCheckOptions = {}): EnvCheckResult {
  const exampleFile = '.env.example'
  const example = readEnvFile(join(root, exampleFile))
  const envFiles = ['.env', ...(options.envName === undefined ? [] : [`.env.${options.envName}`])]
  const layers: { file: string; parsed: EnvFile }[] = []
  for (const file of envFiles) {
    const parsed = readEnvFile(join(root, file))
    if (parsed !== undefined) layers.push({ file, parsed })
  }
  const problems: EnvProblem[] = []
  const soft = options.strict === true ? 'error' : 'warning'

  // Merge layers: later files override earlier ones, as at runtime.
  const merged = new Map<string, { value: string; file: string; line: number }>()
  for (const { file, parsed } of layers) {
    for (const entry of parsed.entries.values()) {
      merged.set(entry.key, { value: entry.value, file, line: entry.line })
    }
    // Invalid keys are reported (by location) below; their text is never echoed.
    for (const key of parsed.duplicates.filter((k) => ENV_KEY.test(k))) {
      problems.push({
        kind: 'duplicate',
        severity: 'warning',
        key,
        file,
        message: `${key} is defined more than once in ${file}; the last value wins.`,
      })
    }
    for (const { line } of parsed.invalid) {
      problems.push({
        kind: 'invalid-line',
        severity: 'error',
        key: `${file}:${line}`,
        file,
        line,
        message: `${file}:${line} is not a KEY=value line.`,
      })
    }
  }

  for (const [key, entry] of merged) {
    if (!ENV_KEY.test(key)) {
      problems.push({
        kind: 'invalid-key',
        severity: 'error',
        key: `${entry.file}:${entry.line}`,
        file: entry.file,
        line: entry.line,
        message: `${entry.file}:${entry.line} does not start with a valid variable name (letters, digits and _ only).`,
      })
      continue
    }
    if (example !== undefined && !example.entries.has(key)) {
      problems.push({
        kind: 'unknown',
        severity: soft,
        key,
        file: entry.file,
        line: entry.line,
        message: `${key} is not documented in ${exampleFile}.`,
      })
    }
    if (entry.value === '') {
      problems.push({
        kind: 'empty',
        severity: soft,
        key,
        file: entry.file,
        line: entry.line,
        message: `${key} is empty in ${entry.file}.`,
      })
    }
  }

  if (example !== undefined) {
    for (const entry of example.entries.values()) {
      if (!merged.has(entry.key)) {
        problems.push({
          kind: 'missing',
          severity: 'error',
          key: entry.key,
          file: '.env',
          message: `${entry.key} is in ${exampleFile} but not set in ${envFiles.join(' / ')}.`,
        })
      }
      if (entry.value !== '' && looksSecret(entry.key, entry.value)) {
        problems.push({
          kind: 'secret-in-example',
          severity: 'error',
          key: entry.key,
          file: exampleFile,
          line: entry.line,
          message: `${entry.key} looks secret but has a value in ${exampleFile}, which is committed. Leave it empty.`,
        })
      }
    }
    for (const { line } of example.invalid) {
      problems.push({
        kind: 'invalid-line',
        severity: 'error',
        key: `${exampleFile}:${line}`,
        file: exampleFile,
        line,
        message: `${exampleFile}:${line} is not a KEY=value line.`,
      })
    }
  }

  const order: Record<EnvProblemKind, number> = {
    'secret-in-example': 0,
    missing: 1,
    'invalid-key': 2,
    'invalid-line': 3,
    unknown: 4,
    empty: 5,
    duplicate: 6,
  }
  problems.sort(
    (a, b) => order[a.kind] - order[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  return { envFiles, exampleFile, exampleExists: example !== undefined, problems }
}
