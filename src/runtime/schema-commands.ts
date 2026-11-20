/**
 * The database commands of migration-first apps (blueprint §2.4, CONSISTENCY #78, #100, #121):
 *
 * | Command | Does |
 * |---|---|
 * | `migrate [--pretend] [--step] [--seed] [--force] [--isolated]` | apply pending migrations, regenerate `.strutvane/`, check drift, optionally seed |
 * | `migrate:status` | ran (with batch), pending and drifted migrations |
 * | `migrate:rollback [--step=N] [--batch=N] [--pretend] [--force]` | undo the last batch (or N migrations) |
 * | `migrate:reset [--force]` | undo every migration |
 * | `migrate:refresh [--seed] [--force]` | reset, then migrate |
 * | `migrate:fresh [--seed] [--force]` | drop every table, then migrate |
 * | `db:seed [--class=PostSeeder] [--tenant=<id>] [--force]` | run the seeders |
 * | `sync` | regenerate `.strutvane/` (types, resources.json, schema.json, SQL) from the migrations, offline |
 *
 * Migrations are always replayed in the F-06 sandbox (a separate process with no secrets, no
 * network and a timeout), never imported into the CLI's own process. In production
 * (`APP_ENV=production`) every command that writes needs `--force` (Laravel's behaviour, #78).
 *
 * The v1 (`defineModel`) commands still run for v1 projects: {@link isMigrationFirst} decides.
 *
 * @module
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandContextLike, ContributedCommand } from '../commands.ts'
import { ValidationError } from '../core/index.ts'
import { databaseSettings, describeDatabase, openDatabase } from '../database/config.ts'
import type { Connection } from '../database/db/connection.ts'
import { configureOrm } from '../database/orm/config.ts'
import { registerSchema } from '../database/schema/registry.ts'
import { runSeeders, seederNameForFile } from '../database/seeding/run.ts'
import type { SeederLike } from '../database/seeding/seeder.ts'
import { assertTenantId } from '../database/types.ts'
import { introspect, schemaDrift } from '../migrations/introspect.ts'
import {
  fresh,
  type MigrationEvent,
  migrate,
  migrationStatus,
  refresh,
  reset,
  rollback,
} from '../migrations/runner.ts'
import { replayInSandbox } from '../migrations/sandbox.ts'
import { EMPTY_SCHEMA } from '../schema/columns.ts'
import { buildArtifacts, writeArtifacts } from '../schema/generate/artifacts.ts'
import { readAppModels } from '../schema/generate/model-options.ts'
import type { Replay } from '../schema/replay.ts'
import { schemaSnapshot } from '../schema/snapshot.ts'
import { realRoot } from '../support/real-path.ts'
import { firstAppEnv } from './app-env.ts'
import { migrationLockTimeoutMs, migrationReplayTimeoutMs } from './migrations.ts'
import { importDefault, loadDotEnv } from './project.ts'
import { generateResourceRoutes, registeredLine } from './resource-generation.ts'
import { isSeeder, type Seeder } from './seeders.ts'

/** Laravel's migration file names; their presence makes a project migration-first. */
const V2_MIGRATION = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+\.ts$/

/** Where migrations and seeders live, relative to the project root. */
export const MIGRATIONS_DIR = 'database/migrations'
/** Where seeders live, relative to the project root. */
export const SEEDERS_DIR = 'database/seeders'

/**
 * Is this a migration-first (v2) project? Yes when `database/migrations` holds a Laravel-named
 * `.ts` migration, when `.strutvane/schema.json` exists, or when there is no v1
 * `strutvane.config.ts`. v1 projects keep the v1 commands until they move.
 *
 * @example
 * isMigrationFirst('/srv/app') // true
 */
export function isMigrationFirst(root: string): boolean {
  const dir = join(root, MIGRATIONS_DIR)
  if (existsSync(dir) && readdirSync(dir).some((file) => V2_MIGRATION.test(file))) return true
  if (existsSync(join(root, '.strutvane', 'schema.json'))) return true
  return !existsSync(join(root, 'strutvane.config.ts'))
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** A positive whole-number flag (`--step=2`), or the reason it isn't one. */
function countFlag(name: string, value: unknown): number | undefined {
  if (value === undefined || value === false) return undefined
  const n = typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(n) || n < 1)
    throw new ValidationError([
      {
        path: [`--${name}`],
        code: 'invalid_flag',
        message: `--${name} must be a whole number of 1 or more.`,
      },
    ])
  return n
}

/** `--tenant`: a UUID, lower-cased; anything else is refused before anything runs. */
function tenantFlag(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    try {
      assertTenantId(value)
      return value.toLowerCase()
    } catch {
      // Reported below with the flag's name.
    }
  }
  throw new ValidationError([
    {
      path: ['--tenant'],
      code: 'invalid_tenant',
      message:
        '--tenant must be a tenant id (a UUID such as 0190a000-0000-7000-8000-0000000000aa).',
    },
  ])
}

/**
 * The environment the command runs with: the process (with `.env` loaded) overlaid by the CLI's
 * resolved environment (`--env` files), the same values the CLI's production guard saw.
 */
function commandEnv(ctx: CommandContextLike): Readonly<Record<string, string | undefined>> {
  return { ...process.env, ...(ctx.services?.env ?? {}) }
}

/**
 * The project root (its real path, resolved once: see `realRoot`), its `.env` loaded (existing
 * variables win) and the CLI's APP_ENV.
 */
function project(ctx: CommandContextLike): { root: string; appEnv: string | undefined } {
  const root = realRoot(ctx.requireProject().root)
  loadDotEnv(root)
  return {
    root,
    appEnv: firstAppEnv(ctx.appEnv, ctx.services?.env?.['APP_ENV'], process.env['APP_ENV']),
  }
}

/** #78: writing to a production database needs `--force`. */
function requireForce(ctx: CommandContextLike, appEnv: string | undefined, command: string): void {
  if (appEnv !== 'production' || ctx.flags['force'] === true) return
  throw new ValidationError([
    {
      path: ['--force'],
      code: 'force_required',
      message: `APP_ENV is production. Run node strut ${command} --force to change the production database.`,
    },
  ])
}

/**
 * Replay the migrations in the sandbox (an empty replay when there is no folder yet), with the
 * default timeout or `timeoutMs` (see {@link migrationReplayTimeoutMs}).
 */
export async function replayProject(root: string, timeoutMs?: number): Promise<Replay> {
  const dir = join(root, MIGRATIONS_DIR)
  if (!existsSync(dir)) return { migrations: [], state: EMPTY_SCHEMA }
  return replayInSandbox(dir, timeoutMs === undefined ? {} : { timeoutMs })
}

/** The replay timeout a command runs with: `--replay-timeout`, `DB_MIGRATION_REPLAY_TIMEOUT` or 10 s. */
function replayTimeout(ctx: CommandContextLike): number {
  return migrationReplayTimeoutMs(commandEnv(ctx), ctx.flags['replay-timeout'])
}

/** Regenerate `.strutvane/` from a replay; returns the files that changed. */
export function syncArtifacts(
  root: string,
  replay: Replay,
  warn: (message: string) => void = () => undefined,
): string[] {
  // resources.json takes mass assignment from the models (read, never run); see model-options.ts.
  const models = readAppModels(root)
  for (const problem of models.problems) warn(problem)
  return writeArtifacts(root, buildArtifacts(replay, {}, { models: models.tables }))
}

/** Point the ORM at a replayed schema and the app's tenancy switch (`config/tenancy.ts`, #90). */
async function prepareOrm(root: string, replay: Replay): Promise<void> {
  registerSchema(schemaSnapshot(replay.state))
  const file = join(root, 'config', 'tenancy.ts')
  if (!existsSync(file)) return
  const config = (await importDefault(file)) as { enabled?: unknown; column?: unknown } | undefined
  if (config?.enabled === true)
    configureOrm({
      tenancy: { column: typeof config.column === 'string' ? config.column : 'tenant_id' },
    })
}

async function withMigrationConnection<T>(
  root: string,
  ctx: CommandContextLike,
  work: (connection: Connection) => Promise<T>,
): Promise<T> {
  const env = commandEnv(ctx)
  const settings = databaseSettings(env, root)
  ctx.out.info(`Database: ${describeDatabase(settings)}`)
  const connection = await openDatabase(settings, {
    forMigrations: { lockTimeoutMs: migrationLockTimeoutMs(env) },
  })
  try {
    return await work(connection)
  } finally {
    await connection.close()
  }
}

function reporter(ctx: CommandContextLike): (event: MigrationEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'migrated':
        ctx.out.success(`Migrated ${event.migration} (batch ${event.batch})`)
        break
      case 'resuming':
        ctx.out.warn(
          `Resuming ${event.migration} after statement ${event.from} (MySQL applies schema changes one statement at a time)`,
        )
        break
      case 'rolled-back':
        ctx.out.success(`Rolled back ${event.migration}`)
        break
      case 'dropped':
        ctx.out.info(`Dropped table ${event.table}`)
        break
      case 'warning':
        ctx.out.warn(`${event.warning.migration}: ${event.warning.message} ${event.warning.hint}`)
        break
      default:
        break
    }
  }
}

/** After a schema change: regenerate `.strutvane/` and compare the database with the replay. */
async function afterChange(
  ctx: CommandContextLike,
  root: string,
  connection: Connection,
  replay: Replay,
): Promise<void> {
  for (const file of syncArtifacts(root, replay, (message) => ctx.out.warn(message)))
    ctx.out.info(`Updated ${file}`)
  await announceResources(ctx, root, replay)
  const drift = schemaDrift(replay.state, await introspect(connection), connection.grammar.dialect)
  for (const line of drift) ctx.out.warn(`Schema drift: ${line}`)
}

/**
 * Blueprint §2.4 step 4: regenerate `routes/resources.gen.ts` and announce each new resource
 * with the DX contract's `registered: API … · UI … · menu "…"` line (FW-4).
 */
async function announceResources(
  ctx: CommandContextLike,
  root: string,
  replay: Replay,
): Promise<void> {
  const generation = generateResourceRoutes(root, replay.state, readAppModels(root))
  for (const warning of generation.warnings) ctx.out.warn(warning)
  for (const file of generation.written) ctx.out.info(`Updated ${file}`)
  if (generation.manualLink !== undefined)
    ctx.out.warn(
      `routes/api.ts was left as it is (it has no single \`export default defineRoutes([\`). Add the generated CRUD routes yourself:\n  ${generation.manualLink.join('\n  ')}`,
    )
  if (generation.added.length === 0) return
  const prefix = await apiPrefixOf(root)
  for (const resource of generation.added) ctx.out.success(registeredLine(resource, prefix))
}

/** The API prefix from `config/api.ts` (`/api` when it has none or can't be read). */
async function apiPrefixOf(root: string): Promise<string> {
  const file = join(root, 'config', 'api.ts')
  if (!existsSync(file)) return '/api'
  try {
    const config = (await importDefault(file)) as { prefix?: unknown } | undefined
    return typeof config?.prefix === 'string' ? config.prefix : '/api'
  } catch {
    return '/api'
  }
}

async function seedWith(
  ctx: CommandContextLike,
  root: string,
  connection: Connection,
  replay: Replay,
  options: {
    readonly className?: string
    readonly tenantId?: string
    readonly appEnv: string | undefined
  },
): Promise<string[]> {
  await prepareOrm(root, replay)
  const dir = join(root, SEEDERS_DIR)
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.seeder.ts'))
        .sort()
    : []
  const names = new Map<SeederLike, string>()
  const byName = new Map<string, Seeder>()
  for (const file of files) {
    const seeder = await importDefault(join(dir, file))
    if (!isSeeder(seeder))
      throw new Error(
        `${SEEDERS_DIR}/${file} must default-export defineSeeder({ async run() { … } })`,
      )
    const name = seeder.anonymous === true ? seederNameForFile(file) : seeder.name
    names.set(seeder, name)
    byName.set(name, seeder)
  }
  const wanted = options.className ?? 'DatabaseSeeder'
  const root_ = byName.get(wanted)
  if (root_ === undefined)
    throw new ValidationError([
      {
        path: options.className === undefined ? [] : ['--class'],
        code: 'seeder_not_found',
        message:
          options.className === undefined
            ? `${SEEDERS_DIR}/database.seeder.ts was not found. Create it, or run node strut db:seed --class=PostSeeder.`
            : `No seeder named $wantedin $SEEDERS_DIR. Seeders there: $[...byName.keys()].join(', ') || 'none'.`,
      },
    ])
  const ran = await runSeeders(root_, {
    connection,
    env: options.appEnv,
    names,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  })
  for (const name of ran) ctx.out.success(`Seeded ${name}`)
  return ran
}

/** `migrate` for migration-first projects. */
export async function migrateV2(
  ctx: CommandContextLike,
): Promise<{ readonly exitCode?: number; readonly data?: unknown }> {
  const { root, appEnv } = project(ctx)
  const pretend = ctx.flags['pretend'] === true
  if (!pretend) requireForce(ctx, appEnv, 'migrate')
  const replay = await replayProject(root, replayTimeout(ctx))
  return withMigrationConnection(root, ctx, async (connection) => {
    const result = await migrate(connection, replay, {
      ...(ctx.flags['step'] === true ? { step: true } : {}),
      ...(pretend ? { pretend: true } : {}),
      ...(ctx.flags['isolated'] === true ? { isolated: true } : {}),
      onEvent: reporter(ctx),
    })
    if (result.locked) {
      ctx.out.warn('Another node strut migrate holds the migration lock; nothing ran (--isolated).')
      return { data: result }
    }
    if (pretend) {
      for (const planned of result.pretend) {
        ctx.out.line(`-- ${planned.migration}`)
        for (const statement of planned.statements) ctx.out.line(`${statement};`)
      }
      return { data: result }
    }
    if (result.ran.length === 0) ctx.out.success('Nothing to migrate.')
    await afterChange(ctx, root, connection, replay)
    const seeded =
      ctx.flags['seed'] === true ? await seedWith(ctx, root, connection, replay, { appEnv }) : []
    return { data: { ...result, seeded } }
  })
}

/** `migrate:status` for migration-first projects. */
export async function statusV2(
  ctx: CommandContextLike,
): Promise<{ readonly exitCode?: number; readonly data?: unknown }> {
  const { root } = project(ctx)
  const replay = await replayProject(root, replayTimeout(ctx))
  return withMigrationConnection(root, ctx, async (connection) => {
    const status = await migrationStatus(connection, replay)
    ctx.out.table(
      ['Migration', 'Status'],
      [
        ...status.ran.map((r) => [r.migration, `ran (batch ${r.batch})`]),
        ...status.pending.map((name) => [name, 'pending']),
        ...status.drift.map((d) => [d.migration, `drift: ${d.kind}`]),
      ],
    )
    return status.drift.length > 0 ? { exitCode: 1, data: status } : { data: status }
  })
}

/** `migrate:rollback`, `migrate:reset`, `migrate:refresh` and `migrate:fresh`. */
async function maintenance(
  ctx: CommandContextLike,
  command: 'migrate:rollback' | 'migrate:reset' | 'migrate:refresh' | 'migrate:fresh',
): Promise<{ readonly exitCode?: number; readonly data?: unknown }> {
  const { root, appEnv } = project(ctx)
  const pretend = ctx.flags['pretend'] === true
  if (!pretend) requireForce(ctx, appEnv, command)
  const step = countFlag('step', ctx.flags['step'])
  const batch = countFlag('batch', ctx.flags['batch'])
  const replay = await replayProject(root, replayTimeout(ctx))
  return withMigrationConnection(root, ctx, async (connection) => {
    const common = {
      onEvent: reporter(ctx),
      ...(ctx.flags['isolated'] === true ? { isolated: true } : {}),
    }
    let data: unknown
    switch (command) {
      case 'migrate:rollback': {
        const result = await rollback(connection, replay, {
          ...common,
          ...(step !== undefined ? { step } : {}),
          ...(batch !== undefined ? { batch } : {}),
          ...(pretend ? { pretend: true } : {}),
        })
        if (pretend)
          for (const planned of result.pretend) {
            ctx.out.line(`-- ${planned.migration}`)
            for (const statement of planned.statements) ctx.out.line(`${statement};`)
          }
        else if (result.rolledBack.length === 0) ctx.out.success('Nothing to roll back.')
        data = result
        break
      }
      case 'migrate:reset':
        data = await reset(connection, replay, common)
        break
      case 'migrate:refresh':
        data = await refresh(connection, replay, common)
        break
      case 'migrate:fresh':
        data = await fresh(connection, replay, common)
        break
    }
    if (pretend) return { data }
    await afterChange(ctx, root, connection, replay)
    const seeded =
      ctx.flags['seed'] === true && (command === 'migrate:refresh' || command === 'migrate:fresh')
        ? await seedWith(ctx, root, connection, replay, { appEnv })
        : []
    return { data: { result: data, seeded } }
  })
}

/** `db:seed` for migration-first projects (#100). */
export async function seedV2(
  ctx: CommandContextLike,
): Promise<{ readonly exitCode?: number; readonly data?: unknown }> {
  const tenantId = tenantFlag(ctx.flags['tenant'])
  const { root, appEnv } = project(ctx)
  requireForce(ctx, appEnv, 'db:seed')
  const className = str(ctx.flags['class'])
  const replay = await replayProject(root, replayTimeout(ctx))
  const settings = databaseSettings(commandEnv(ctx), root)
  const connection = await openDatabase(settings)
  try {
    const ran = await seedWith(ctx, root, connection, replay, {
      appEnv,
      ...(className !== undefined ? { className } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
    })
    return { data: { ran } }
  } finally {
    await connection.close()
  }
}

const forceFlag = {
  type: 'boolean',
  description: 'Allow changing the database when APP_ENV is production',
} as const
const seedFlag = {
  type: 'boolean',
  description: 'Run database/seeders/database.seeder.ts afterwards',
} as const
const isolatedFlag = {
  type: 'boolean',
  description: "Don't wait when another migrate holds the lock: report it and do nothing",
} as const
const replayTimeoutFlag = {
  type: 'string',
  description:
    'How long replaying the migrations may take (30s, 2min; default 10s or DB_MIGRATION_REPLAY_TIMEOUT)',
} as const

/** The flags of `migrate:status` for migration-first projects. */
export const STATUS_V2_FLAGS: NonNullable<ContributedCommand['flags']> = {
  'replay-timeout': replayTimeoutFlag,
}

/** The flags of `migrate` for migration-first projects. */
export const MIGRATE_V2_FLAGS: NonNullable<ContributedCommand['flags']> = {
  pretend: {
    type: 'boolean',
    description: 'Print the SQL the pending migrations would run; change nothing',
  },
  step: {
    type: 'boolean',
    description: 'One batch per migration, so they roll back one at a time',
  },
  seed: seedFlag,
  force: forceFlag,
  isolated: isolatedFlag,
  'replay-timeout': replayTimeoutFlag,
}

/** The flags of `db:seed` for migration-first projects. */
export const SEED_V2_FLAGS: NonNullable<ContributedCommand['flags']> = {
  class: { type: 'string', description: 'Run one seeder, e.g. PostSeeder' },
  tenant: { type: 'string', description: 'Seed inside this tenant (a UUID)' },
  force: forceFlag,
  'replay-timeout': replayTimeoutFlag,
}

function maintenanceCommand(
  name: 'migrate:rollback' | 'migrate:reset' | 'migrate:refresh' | 'migrate:fresh',
  description: string,
  flags: NonNullable<ContributedCommand['flags']>,
): ContributedCommand {
  return {
    name,
    description,
    destructive: true,
    flags: {
      force: forceFlag,
      isolated: isolatedFlag,
      'replay-timeout': replayTimeoutFlag,
      ...flags,
    },
    run: (ctx) => maintenance(ctx, name),
  }
}

/** The migration-first commands that have no v1 counterpart. */
export const schemaCommands: readonly ContributedCommand[] = Object.freeze([
  maintenanceCommand(
    'migrate:rollback',
    'Roll back the last batch of migrations (or --step=N of them)',
    {
      step: { type: 'string', description: 'Roll back this many migrations' },
      batch: { type: 'string', description: 'Roll back this batch' },
      pretend: { type: 'boolean', description: 'Print the SQL; change nothing' },
    },
  ),
  maintenanceCommand('migrate:reset', 'Roll back every migration', {}),
  maintenanceCommand('migrate:refresh', 'Roll back every migration, then migrate again', {
    seed: seedFlag,
  }),
  maintenanceCommand('migrate:fresh', 'Drop every table, then migrate from scratch', {
    seed: seedFlag,
  }),
  {
    name: 'sync',
    description:
      'Regenerate .strutvane/ (types, resources.json, schema.json, SQL) from the migrations',
    flags: { 'replay-timeout': replayTimeoutFlag },
    async run(ctx) {
      const { root } = project(ctx)
      const written = syncArtifacts(
        root,
        await replayProject(root, replayTimeout(ctx)),
        (message) => ctx.out.warn(message),
      )
      if (written.length === 0) ctx.out.success('.strutvane/ is up to date.')
      for (const file of written) ctx.out.success(`Updated ${file}`)
      return { data: { written } }
    },
  },
])

/**
 * Route `migrate`, `migrate:status` and `db:seed` to the migration-first implementation in v2
 * projects and to the given v1 command otherwise. The flags are the union of both.
 *
 * @example
 * const migrate = dispatchByProject(v1Migrate, migrateV2, MIGRATE_V2_FLAGS)
 */
export function dispatchByProject(
  v1: ContributedCommand,
  v2: ContributedCommand['run'],
  flags: NonNullable<ContributedCommand['flags']> = {},
): ContributedCommand {
  return {
    ...v1,
    flags: { ...v1.flags, ...flags },
    run: (ctx) => (isMigrationFirst(ctx.requireProject().root) ? v2(ctx) : v1.run(ctx)),
  }
}
