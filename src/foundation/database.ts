/**
 * The application's database, Laravel-style: models just work inside requests and commands.
 *
 * What the application does with it, and when:
 *
 * | When | What |
 * |---|---|
 * | `create()` | nothing (no I/O) |
 * | `boot()` | the ORM gets the schema snapshot (`.strutvane/schema.json`, written by `node strut migrate`) and the tenancy switch (`config/tenancy.ts`); the connection is **bound** in the container, not opened |
 * | the first query | the connection opens (lazily, once), from `config/database.ts` and `DB_*` in `.env` |
 * | every request and command | models resolve this app's connection (never another app's in the same process); with tenancy on, the request's tenant scopes every query |
 * | `shutdown()` | the connection closes (only if it was ever opened) |
 *
 * **Where the settings come from.** `config/database.ts` (`default`, `host`, `port`, `database`,
 * `username`, `socket`, `sslmode`, `ssl_ca`) wins over `.env`, like every other config value; the
 * password and `DB_URL` are read from the environment when the connection opens, so they never sit
 * in the config tree (or a config cache). With `APP_ENV=testing` and `database.test_database` set,
 * that database is used, so `npm test` never touches local data.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Container, type Token, token } from '../core/container.ts'
import { databaseSettings, openDatabaseLazily } from '../database/config.ts'
import type { Connection } from '../database/db/connection.ts'
import { configureOrm, ormConfig } from '../database/orm/config.ts'
import { registerSchema } from '../database/schema/registry.ts'
import { parseSchemaSnapshot } from '../schema/snapshot.ts'
import { BootError } from './boot-error.ts'
import type { ConfigRepository } from './config.ts'
import type { EnvSource } from './env.ts'

/**
 * The application's default ORM connection (models, `transaction()`). Bound when the app boots,
 * opened by the first query, closed on shutdown. Bind your own before boot to replace it (tests).
 *
 * @example
 * await app.make(DatabaseConnectionToken).run(sql`SELECT 1`)
 */
export const DatabaseConnectionToken: Token<Connection> = token<Connection>(
  'strutvane.database.connection',
)

/** `config/database.ts` keys → the `DB_*` names `databaseSettings` reads. */
const CONFIG_KEYS: readonly (readonly [string, string])[] = [
  ['default', 'DB_CONNECTION'],
  ['url', 'DB_URL'],
  ['host', 'DB_HOST'],
  ['port', 'DB_PORT'],
  ['database', 'DB_DATABASE'],
  ['username', 'DB_USERNAME'],
  ['password', 'DB_PASSWORD'],
  ['socket', 'DB_SOCKET'],
  ['sslmode', 'DB_SSLMODE'],
  ['ssl_ca', 'DB_SSL_CA'],
]

/**
 * The `DB_*` values the app connects with: `.env` first, then `config/database.ts` over it, then
 * the test database when `APP_ENV=testing`.
 *
 * @example
 * databaseEnv(config, { DB_CONNECTION: 'sqlite' }, 'local')['DB_CONNECTION'] // 'sqlite'
 */
export function databaseEnv(
  config: ConfigRepository,
  env: EnvSource,
  environment: string,
): EnvSource {
  const merged: Record<string, string | undefined> = { ...env }
  for (const [key, name] of CONFIG_KEYS) {
    const value = configValue(config, `database.${key}`)
    if (value !== undefined) merged[name] = value
  }
  const testDatabase = configValue(config, 'database.test_database')
  if (environment === 'testing' && testDatabase !== undefined) merged['DB_DATABASE'] = testDatabase
  return merged
}

/** A config value as text (numbers too: a port), or undefined when unset or empty. */
function configValue(config: ConfigRepository, path: string): string | undefined {
  if (!config.has(path)) return undefined
  const value = config.get(path)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Bind the lazy default connection, unless a provider (or a test) bound one already. The settings
 * are read on first use too, so an app that never queries never needs valid `DB_*` keys.
 *
 * @example
 * bindDatabase(app.container, { basePath, env: () => databaseEnv(config, source, 'local') })
 */
export function bindDatabase(
  container: Container,
  options: { readonly basePath: string; readonly env: () => EnvSource },
): void {
  if (container.has(DatabaseConnectionToken)) return
  container.singleton(
    DatabaseConnectionToken,
    () => openDatabaseLazily(databaseSettings(options.env(), options.basePath)),
    { dispose: (connection) => connection.close() },
  )
}

/**
 * Hand the ORM the app's schema snapshot (`.strutvane/schema.json`), when the app has one. A
 * malformed file stops the boot with the fix, instead of failing on the first query.
 *
 * @example
 * loadSchemaSnapshot('/srv/blog') // true when .strutvane/schema.json exists
 */
export function loadSchemaSnapshot(basePath: string): boolean {
  const file = join(basePath, '.strutvane', 'schema.json')
  if (!existsSync(file)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
    registerSchema(parseSchemaSnapshot(parsed))
  } catch (error) {
    throw new BootError(
      'invalid_schema_snapshot',
      `.strutvane/schema.json can't be read: ${error instanceof Error ? error.message : String(error)}`,
      'Regenerate it with `node strut sync` (or `node strut migrate`); never edit it by hand.',
    )
  }
  return true
}

/**
 * The tenancy switch: `tenancy` in the config tree when the app lists it, else the plain-data
 * `config/tenancy.ts` the CLI reads too (CONSISTENCY #90). Returns the tenant column, or
 * `undefined` when tenancy is off. An app with neither leaves the ORM's setting as it is.
 *
 * @example
 * await configureTenancy('/srv/blog', config) // 'tenant_id' when config/tenancy.ts enables it
 */
export async function configureTenancy(
  basePath: string,
  config: ConfigRepository,
): Promise<string | undefined> {
  const setting = config.has('tenancy') ? config.get('tenancy') : await tenancyFile(basePath)
  if (setting === undefined) {
    const current = ormConfig().tenancy
    return current === false ? undefined : current.column
  }
  const enabled = isRecord(setting) && setting['enabled'] === true
  const column = isRecord(setting) && typeof setting['column'] === 'string' ? setting['column'] : ''
  const tenancy = enabled ? { column: column === '' ? 'tenant_id' : column } : false
  configureOrm({ tenancy })
  return tenancy === false ? undefined : tenancy.column
}

async function tenancyFile(basePath: string): Promise<unknown> {
  const file = join(basePath, 'config', 'tenancy.ts')
  if (!existsSync(file)) return undefined
  const module = (await import(pathToFileURL(file).href)) as { readonly default?: unknown }
  return module.default
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}
