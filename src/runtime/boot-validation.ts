/**
 * Boot validation: the settings the framework reads from `config/*.ts` (which a generated app
 * fills from `.env`) are checked before anything boots, and every problem is reported at once as
 * an {@link EnvValidationError} naming the env key. The CLI renders that as "Invalid environment"
 * with exit 3 (a configuration error), never a stack trace or exit 1.
 *
 * Why the framework checks again when the app's own `env.schema.ts` already validates: that
 * schema checks shapes (`z.string().min(1)`), not meaning. A timezone no formatter knows, a locale
 * that is not a language tag, an API prefix without its slash, a CORS "origin" with a path, an
 * empty `TRUST_PROXY` coerced to `0`, or a SQLite file in a folder that does not exist all passed
 * it, and then either booted broken or failed later with a driver error.
 *
 * Messages never contain the value (it may be a secret), only the key, the config path and how to
 * fix it.
 *
 * @module
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EnvProblem, EnvSource } from '../core/index.ts'
import { exactOrigin } from '../http/csrf.ts'
import { type AppDatabaseConfig, databaseConfigFrom } from './database-config.ts'
import type { LoadedProject } from './project.ts'

type Section = Readonly<Record<string, unknown>> | undefined

const section = (config: LoadedProject['config'], name: string): Section => {
  const value = config[name]
  return typeof value === 'object' && value !== null ? (value as Section) : undefined
}

/** `true` when `Intl` accepts `zone` as an IANA time zone. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** `true` when `tag` is a well-formed BCP 47 language tag. */
function isLocale(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1
  } catch {
    return false
  }
}

const API_PREFIX = /^\/[A-Za-z0-9\-._~/]*$/

/**
 * Every problem with the boot settings of `project`, in a stable order. Empty when all is well.
 * `env` is consulted for values the config cannot show (an empty `TRUST_PROXY` is coerced to `0`
 * by the generated schema).
 *
 * @example
 * validateBootSettings(project) // [{ key: 'APP_TIMEZONE', message: '…' }]
 */
export function validateBootSettings(
  project: Pick<LoadedProject, 'root' | 'config'>,
  env: EnvSource = process.env,
): EnvProblem[] {
  const problems: EnvProblem[] = []
  const add = (key: string, message: string): void => {
    problems.push({ key, message })
  }
  const app = section(project.config, 'app')
  const api = section(project.config, 'api')
  const cors = section(project.config, 'cors')

  const timezone = app?.['timezone']
  if (timezone !== undefined && (typeof timezone !== 'string' || !isTimeZone(timezone)))
    add(
      'APP_TIMEZONE',
      'must be an IANA time zone such as UTC or Europe/Berlin (config/app.ts timezone)',
    )

  const locale = app?.['locale']
  if (locale !== undefined && (typeof locale !== 'string' || !isLocale(locale)))
    add('APP_LOCALE', 'must be a language tag such as en or pt-BR (config/app.ts locale)')

  const prefix = api?.['prefix']
  if (prefix !== undefined && (typeof prefix !== 'string' || !API_PREFIX.test(prefix)))
    add(
      'API_PREFIX',
      'must be a path that starts with "/", such as /api (letters, digits and -._~/ only; config/api.ts prefix)',
    )

  const origins = cors?.['origins']
  if (
    origins !== undefined &&
    (!Array.isArray(origins) || origins.some((origin) => exactOrigin(origin) === undefined))
  )
    add(
      'CORS_ORIGINS',
      'must be a comma-separated list of origins such as https://app.example.com (scheme and host, no path, no "*"; config/cors.ts origins)',
    )

  const rawTrust = env['TRUST_PROXY']
  const trust = app?.['trustProxy']
  if (
    (rawTrust !== undefined && rawTrust.trim() === '') ||
    (trust !== undefined &&
      typeof trust !== 'boolean' &&
      !(typeof trust === 'number' && Number.isInteger(trust) && trust >= 0 && trust <= 32))
  )
    add(
      'TRUST_PROXY',
      'must be the number of trusted proxy hops, 0 to 32 (0 = none; empty is not allowed; config/app.ts trustProxy)',
    )

  const publicUrl = app?.['publicUrl']
  if (
    publicUrl !== undefined &&
    publicUrl !== '' &&
    (typeof publicUrl !== 'string' ||
      !URL.canParse(publicUrl) ||
      !/^https?:$/.test(new URL(publicUrl).protocol))
  )
    add('APP_URL', 'must be an absolute http(s) URL such as https://app.example.com')

  const database = sqliteFileProblem(project)
  if (database !== undefined) add('DB_DATABASE', database)

  return problems.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * Why the SQLite file cannot be opened, or `undefined`. The driver creates a missing file, but
 * not a missing folder, and cannot open a folder as a database: both used to fail only when the
 * first query ran, with the driver's own message and exit 1.
 */
function sqliteFileProblem(project: Pick<LoadedProject, 'root' | 'config'>): string | undefined {
  const database = section(project.config, 'database')
  // Only what the app configured: without config/database.ts the provider decides the connection.
  if (database === undefined) return undefined
  let url: string
  try {
    const connection = databaseConfigFrom(database as AppDatabaseConfig, project.root)
    if (connection.driver !== 'sqlite' || !connection.url.startsWith('file:')) return undefined
    url = connection.url
  } catch {
    // An unknown driver or missing Postgres host is reported by the provider with its own text.
    return undefined
  }
  const file = fileURLToPath(url)
  const where = 'config/database.ts connection.filename'
  const stat = (path: string) => {
    try {
      return statSync(path)
    } catch {
      return undefined
    }
  }
  const existing = stat(file)
  if (existing?.isDirectory())
    return `names a folder, not a SQLite file; use a file path such as storage/database.sqlite (${where})`
  if (existing === undefined && !stat(dirname(file))?.isDirectory())
    return `the folder for the SQLite file does not exist; create it or use a path inside storage/ (${where})`
  return undefined
}
