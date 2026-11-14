/**
 * `APP_ENV`, read the same way everywhere: by the CLI's production guard and by the runtime.
 *
 * Values are trimmed and lowercased, and an empty value (`APP_ENV=`) means unset. Without that,
 * `APP_ENV=" Local"` or a blank line would make the guard and the app disagree about where they
 * run (one treating it as local, the other as production), which is exactly the kind of mismatch
 * that lets a destructive command or an allow-all permission default slip through.
 *
 * Precedence, first non-empty value wins: an explicit value (`--env`, `ctx.appEnv`, `options.env`),
 * then `config/app.ts` `env`, then the process environment. With none, callers fall back to
 * `production` (fail closed).
 *
 * @module
 */

/** Trim and lowercase; empty or non-string means unset. */
export function normaliseAppEnv(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  return value === '' ? undefined : value
}

/** The first candidate that is set after normalisation, else `undefined`. */
export function firstAppEnv(...candidates: readonly unknown[]): string | undefined {
  for (const c of candidates) {
    const value = normaliseAppEnv(c)
    if (value !== undefined) return value
  }
  return undefined
}

/** The value `APP_ENV` has in the process environment (normalised). */
export function processAppEnv(): string | undefined {
  return normaliseAppEnv(process.env['APP_ENV'])
}
