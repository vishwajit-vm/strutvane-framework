/**
 * Resolving `APP_ENV` the way the app will see it, for the production guard (docs/09 §4).
 *
 * Order (first non-empty value wins):
 * 1. the process environment (a variable set but empty, `APP_ENV=`, counts as unset);
 * 2. `.env.<name>` when `--env <name>` is given;
 * 3. `.env`.
 * Values are trimmed and lowercased, and quotes and `export ` prefixes are understood (see
 * `env-file.ts`), so `export APP_ENV=" Production "` is `production`.
 *
 * The guard fails closed: destructive commands run without confirmation only when the resolved
 * value is one of {@link SAFE_APP_ENVS}. Anything else, including no value at all (the runtime
 * then defaults to `production`), needs `--force --i-understand`.
 *
 * The runner hands the resolved value to the command (`ctx.appEnv`, `ctx.services.env.APP_ENV`,
 * and the process environment), so the guard and the command can never disagree about it.
 *
 * @module
 */
import { join } from 'node:path'
import { ENV_KEY, readEnvFile } from './env-file.ts'

/** Environments where destructive commands run without `--force --i-understand`. */
export const SAFE_APP_ENVS: ReadonlySet<string> = new Set([
  'local',
  'test',
  'testing',
  'development',
])

/** Where the resolved value came from. */
export type AppEnvSource = 'process' | `.env.${string}` | '.env'

/** The resolved `APP_ENV`. */
export interface ResolvedAppEnv {
  /** Trimmed, lowercased; `undefined` when no source sets a non-empty value. */
  readonly value: string | undefined
  readonly source: AppEnvSource | undefined
}

/** Trim and lowercase; empty means unset. */
export function normaliseAppEnv(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase()
  return value === undefined || value === '' ? undefined : value
}

/** Options for {@link resolveAppEnv}. */
export interface ResolveAppEnvOptions {
  readonly processEnv: Readonly<Record<string, string | undefined>>
  /** The project root; without one only the process environment is consulted. */
  readonly root: string | undefined
  /** `--env <name>` (already validated as a plain name). */
  readonly envName: string | undefined
}

/** Resolve `APP_ENV` as the runtime will. */
export function resolveAppEnv(options: ResolveAppEnvOptions): ResolvedAppEnv {
  const fromProcess = normaliseAppEnv(options.processEnv['APP_ENV'])
  if (fromProcess !== undefined) return { value: fromProcess, source: 'process' }
  if (options.root !== undefined) {
    const files: (`.env.${string}` | '.env')[] = [
      ...(options.envName === undefined ? [] : [`.env.${options.envName}` as const]),
      '.env',
    ]
    for (const file of files) {
      const value = normaliseAppEnv(
        readEnvFile(join(options.root, file))?.entries.get('APP_ENV')?.value,
      )
      if (value !== undefined) return { value, source: file }
    }
  }
  return { value: undefined, source: undefined }
}

/** Whether destructive commands may run in `appEnv` without confirmation. */
export function isSafeAppEnv(appEnv: string | undefined): boolean {
  return appEnv !== undefined && SAFE_APP_ENVS.has(appEnv)
}

/**
 * The variables `--env <name>` adds for the command: every valid key of `.env.<name>` that the
 * process environment does not already set to a non-empty value (the runtime later loads `.env`
 * without overriding, so `.env.<name>` wins over `.env`, as documented). A `Map`, so no key can
 * touch an object prototype.
 */
export function envFileOverlay(
  root: string,
  envName: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): Map<string, string> {
  const overlay = new Map<string, string>()
  const file = readEnvFile(join(root, `.env.${envName}`))
  if (file === undefined) return overlay
  for (const entry of file.entries.values()) {
    if (!ENV_KEY.test(entry.key) || entry.key === '__proto__') continue
    const current = Object.hasOwn(processEnv, entry.key) ? processEnv[entry.key] : undefined
    if (current === undefined || current === '') overlay.set(entry.key, entry.value)
  }
  return overlay
}
