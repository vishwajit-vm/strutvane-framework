/**
 * Typed, validated environment variables for `config/*.ts`: Laravel's `env('APP_DEBUG', false)`,
 * but every read says what type it expects, and *all* problems are collected and reported
 * together at boot.
 *
 * **Why collect instead of throwing on the first bad key:** fixing a fresh deployment one variable
 * at a time ("restart, next error, restart…") is the most frustrating loop in operations.
 *
 * **Never echoes secrets:** a problem quotes the bad value only for variables whose type makes a
 * secret impossible (booleans, numbers, choices); text and URL problems name the variable only.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

/**
 * One problem with one environment variable.
 *
 * @example
 * const issue: EnvIssue = { key: 'APP_DEBUG', message: 'must be true or false (got "yes")' }
 */
export interface EnvIssue {
  readonly key: string
  readonly message: string
}

/**
 * The raw variables: `.env` merged with the process environment.
 *
 * @example
 * const source: EnvSource = { APP_ENV: 'testing' }
 */
export type EnvSource = Readonly<Record<string, string | undefined>>

/**
 * The environments an app runs in (CONSISTENCY #60). `withoutCsrf()` and the other test switches
 * work only in `testing`; debug details only in `local` and `testing`.
 *
 * @example
 * env.oneOf('APP_ENV', APP_ENVIRONMENTS, 'production')
 */
export const APP_ENVIRONMENTS: readonly ['local', 'testing', 'staging', 'production'] =
  Object.freeze(['local', 'testing', 'staging', 'production'] as const)

/**
 * The reader handed to every `config/*.ts` file.
 *
 * Each method returns a value of the right type even when the variable is wrong (a harmless
 * placeholder), so one config file can report *every* bad key before boot fails.
 *
 * @example
 * export default defineConfig((env) => ({ debug: env.boolean('APP_DEBUG', false) }))
 */
export class Env {
  readonly #source: EnvSource
  readonly #issues: EnvIssue[] = []

  constructor(source: EnvSource) {
    this.#source = source
  }

  /**
   * Every problem found so far.
   *
   * @example
   * env.issues.length // 0 when every variable was fine
   */
  get issues(): readonly EnvIssue[] {
    return this.#issues
  }

  /**
   * A string. Without a fallback, the variable is required.
   *
   * @example
   * env.string('APP_NAME', 'Strutvane')
   */
  string(key: string, fallback?: string): string {
    const raw = this.#read(key)
    if (raw !== undefined) return raw
    if (fallback !== undefined) return fallback
    this.#missing(key, 'a text value')
    return ''
  }

  /**
   * A string that may be absent.
   *
   * @example
   * env.optional('DB_PASSWORD') // string | undefined
   */
  optional(key: string): string | undefined {
    return this.#read(key)
  }

  /**
   * A whole number.
   *
   * @example
   * env.integer('DB_PORT', 5432)
   */
  integer(key: string, fallback?: number): number {
    const raw = this.#read(key)
    if (raw === undefined) {
      if (fallback !== undefined) return fallback
      this.#missing(key, 'a whole number')
      return 0
    }
    if (/^-?\d{1,15}$/.test(raw)) return Number(raw)
    this.#issues.push({ key, message: `must be a whole number (got "${short(raw)}")` })
    return fallback ?? 0
  }

  /**
   * `true`/`false` (also accepts `1`/`0`, like Laravel).
   *
   * @example
   * env.boolean('APP_DEBUG', false)
   */
  boolean(key: string, fallback?: boolean): boolean {
    const raw = this.#read(key)?.toLowerCase()
    if (raw === undefined) {
      if (fallback !== undefined) return fallback
      this.#missing(key, 'true or false')
      return false
    }
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    this.#issues.push({ key, message: `must be true or false (got "${short(raw)}")` })
    return fallback ?? false
  }

  /**
   * One value from a fixed list. The return type is the list's union.
   *
   * @example
   * env.oneOf('APP_ENV', ['local', 'testing', 'staging', 'production'], 'production')
   */
  oneOf<const TValues extends readonly [string, ...string[]]>(
    key: string,
    values: TValues,
    fallback?: TValues[number],
  ): TValues[number] {
    const raw = this.#read(key)
    const match = values.find((value) => value === raw)
    if (match !== undefined) return match
    if (raw === undefined && fallback !== undefined) return fallback
    if (raw === undefined) this.#missing(key, `one of ${values.join(', ')}`)
    else
      this.#issues.push({
        key,
        message: `must be one of ${values.join(', ')} (got "${short(raw)}")`,
      })
    return fallback ?? values[0]
  }

  /**
   * An absolute http(s) URL.
   *
   * @example
   * env.url('APP_URL', 'http://localhost:3000')
   */
  url(key: string, fallback?: string): string {
    const value = this.string(key, fallback)
    if (value === '' || isHttpUrl(value)) return value
    // The value is not echoed: URLs carry credentials (database and queue URLs) often enough.
    this.#issues.push({ key, message: 'must be a full http(s) URL such as http://localhost:3000' })
    return fallback ?? ''
  }

  #read(key: string): string | undefined {
    const raw = this.#source[key]
    // An empty value means "not set", as in Laravel's .env handling.
    return raw === undefined || raw === '' ? undefined : raw
  }

  #missing(key: string, expected: string): void {
    this.#issues.push({ key, message: `is required (${expected}); add it to .env` })
  }
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** A quoted bad value, capped: a long value is never useful in an error and may be a secret. */
function short(value: string): string {
  return value.length > 40 ? `${value.slice(0, 20)}…` : value
}

/**
 * Read `<basePath>/.env` if it exists and merge it under the real environment: values set in the
 * process (by the shell, Docker or CI) win, exactly like Laravel's dotenv behaviour.
 *
 * Pass `override` (tests do) to ignore `process.env` completely and get deterministic config.
 *
 * @example
 * const source = loadEnvSource('/srv/app', undefined) // .env + process.env
 */
export function loadEnvSource(basePath: string, override: EnvSource | undefined): EnvSource {
  const file = join(basePath, '.env')
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  return { ...fromFile, ...(override ?? process.env) }
}
