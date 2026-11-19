/**
 * CLI commands contributed by `@strutvane/framework` (package.json `strutvane.commands`).
 *
 * The CLI loads this module from the project's own `node_modules` and lets these replace its
 * placeholders (`migrate`, `migrate:status`, `db:seed`) and add `dev`, `start` and `build`. The
 * framework never imports the CLI: commands are plain objects in the CLI's documented shape
 * (name, description, flags, `run(ctx)`), checked by the CLI when it loads them.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUuidV7Generator, ValidationError } from './core/index.ts'
import { connectDatabase } from './database/connect.ts'
import { assertTenantId } from './database/types.ts'
import { answersResolver } from './migrations/files.ts'
import type { RenameDecision } from './migrations/planner.ts'
import { createModelRegistry } from './model/registry.ts'
import { firstAppEnv } from './runtime/app-env.ts'
import { findViteConfig, projectPackageManifest } from './runtime/dev-ui.ts'
import {
  migrateProject,
  migrationTarget,
  type PackageMigrationDir,
  projectMigrationStatus,
} from './runtime/migrations.ts'
import { importDefault, type LoadedProject, loadProject } from './runtime/project.ts'
import {
  dispatchByProject,
  MIGRATE_V2_FLAGS,
  migrateV2,
  SEED_V2_FLAGS,
  STATUS_V2_FLAGS,
  schemaCommands,
  seedV2,
  statusV2,
} from './runtime/schema-commands.ts'
import { isSeeder, runSeeder } from './runtime/seeders.ts'
import { assertCanListen } from './runtime/serve.ts'
import { exitCodeForStop, startedEnv, startProject, stopOnSignals } from './runtime/server.ts'

/** The parts of the CLI's command context these commands use. */
export interface CommandContextLike {
  readonly flags: Readonly<Record<string, string | boolean | string[] | undefined>>
  requireProject(): { readonly root: string }
  /**
   * `APP_ENV` as the CLI resolved it (process env, then `.env.<--env>`, then `.env`; trimmed,
   * lowercased, empty = unset). Commands use it instead of re-reading `.env`, so the CLI's
   * production guard and the command always agree.
   */
  readonly appEnv?: string | undefined
  /**
   * The package migration folders the CLI's gate allowed (enabled in strutvane.config.ts, direct
   * dependency, compat, real path inside the package). Absent (an older CLI) means none: package
   * migrations then never run (fail closed).
   */
  packageMigrations?(): readonly PackageMigrationDir[]
  /** CLI services; `env` is the environment the command runs with (`APP_ENV` included). */
  readonly services?: { readonly env?: Readonly<Record<string, string | undefined>> }
  readonly out: {
    line(text?: string): void
    success(text: string): void
    info(text: string): void
    warn(text: string): void
    table(headers: readonly string[], rows: readonly (readonly string[])[]): void
  }
}

/** A contributed command, in the CLI's shape. */
export interface ContributedCommand {
  readonly name: string
  readonly description: string
  readonly details?: string
  readonly destructive?: boolean
  readonly flags?: Readonly<
    Record<
      string,
      {
        readonly type: 'boolean' | 'string'
        readonly description?: string
        readonly multiple?: boolean
      }
    >
  >
  run(
    ctx: CommandContextLike,
  ): Promise<{ readonly exitCode?: number; readonly data?: unknown } | undefined>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** `--rename old=new` / `--separate old=new` answers → a rename resolver input. */
export function renameAnswers(
  renames: readonly string[],
  separate: readonly string[],
): Record<string, RenameDecision> {
  const out: Record<string, RenameDecision> = {}
  for (const [list, decision] of [
    [renames, 'rename'],
    [separate, 'separate'],
  ] as const) {
    for (const entry of list) {
      if (!/^[^=\s]+=[^=\s]+$/.test(entry))
        throw new Error(
          `Expected old=new (invoices=bills, or invoices.total=amount), got "${entry}"`,
        )
      const [from = '', to = ''] = entry.split('=')
      out[from.includes('.') ? `column ${from} -> ${to}` : `table ${from} -> ${to}`] = decision
    }
  }
  return out
}

/** The APP_ENV the CLI resolved for this command (`ctx.appEnv`, else `ctx.services.env`). */
export function commandAppEnv(ctx: CommandContextLike): string | undefined {
  return firstAppEnv(ctx.appEnv, ctx.services?.env?.['APP_ENV'])
}

/** Load the project with the CLI's APP_ENV (never a different one re-read from `.env`). */
function loadFor(ctx: CommandContextLike): Promise<LoadedProject> {
  const appEnv = commandAppEnv(ctx)
  return loadProject(ctx.requireProject().root, appEnv !== undefined ? { appEnv } : {})
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []

const migrateCommand: ContributedCommand = {
  name: 'migrate',
  description: 'Diff models with the database, write a migration and apply it',
  flags: {
    name: { type: 'string', description: 'Name for the generated migration (default "auto")' },
    pretend: {
      type: 'boolean',
      description: 'Write the migration and list package migrations, but apply nothing',
    },
    'allow-destructive': { type: 'boolean', description: 'Allow dropping tables or columns' },
    rename: {
      type: 'string',
      multiple: true,
      description: 'Confirm a rename: table=new or table.column=new',
    },
    separate: { type: 'string', multiple: true, description: 'Reject a rename: old=new' },
  },
  async run(ctx) {
    const project = await loadFor(ctx)
    const answers = renameAnswers(list(ctx.flags['rename']), list(ctx.flags['separate']))
    const result = await migrateProject(project, {
      ...(str(ctx.flags['name']) ? { name: str(ctx.flags['name']) as string } : {}),
      ...(ctx.flags['pretend'] === true ? { pretend: true } : {}),
      ...(ctx.flags['allow-destructive'] === true ? { allowDestructive: true } : {}),
      ...(Object.keys(answers).length > 0 ? { resolveRename: answersResolver(answers) } : {}),
      packageMigrations: ctx.packageMigrations?.() ?? [],
    })
    const sourceOf = new Map(result.packaged.map((m) => [m.name, m.source]))
    const from = (name: string): string => {
      const source = sourceOf.get(name)
      return source !== undefined ? ` (from ${source})` : ''
    }
    if (result.created) ctx.out.success(`Created migration ${result.created}.sql`)
    if (ctx.flags['pretend'] === true) {
      for (const m of result.packaged)
        ctx.out.info(`Package migration ${m.name}${from(m.name)}: runs if not applied yet`)
    }
    for (const name of result.applied) ctx.out.success(`Applied ${name}${from(name)}`)
    if (!result.created && result.applied.length === 0) ctx.out.success('Nothing to migrate.')
    return { data: result }
  },
}

const statusCommand: ContributedCommand = {
  name: 'migrate:status',
  description: 'Show applied, pending and drifted migrations',
  async run(ctx) {
    const project = await loadFor(ctx)
    const status = await projectMigrationStatus(project, {
      packageMigrations: ctx.packageMigrations?.() ?? [],
    })
    const source = (name: string): string => status.sources[name] ?? 'app'
    ctx.out.table(
      ['Migration', 'Source', 'Status'],
      [
        ...status.applied.map((a) => [a.name, source(a.name), `applied (batch ${a.batch})`]),
        ...status.pending.map((p) => [p, source(p), 'pending']),
        ...status.drift.map((d) => [d.name, source(d.name), `drift: ${d.kind}`]),
      ],
    )
    return status.drift.length > 0 ? { exitCode: 1, data: status } : { data: status }
  },
}

/** `invoice-line.seeder.ts` → `InvoiceLineSeeder` (the `--class` naming rule, reversed). */
export function seederClassName(file: string): string {
  const base = file.replace(/\.seeder\.ts$/, '')
  const pascal = base
    .split(/[-_.]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `${pascal}Seeder`
}

/** Seeder files in `dir` other than `database.seeder.ts`, sorted. Missing folder → none. */
export async function seederFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith('.seeder.ts') && f !== 'database.seeder.ts')
      .sort()
  } catch {
    return []
  }
}

/**
 * The `--tenant` flag: absent, or a tenant id (a UUID, as the database's tenant setting requires).
 * A malformed value is refused before anything runs.
 */
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

/** The `code` of an error or of any error in its `cause` chain. */
function codeOf(error: unknown): string | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth++) {
    if ('code' in current && typeof current.code === 'string') return current.code
    current = current.cause
  }
  return undefined
}

/**
 * The seeder files `node strut db:seed` should warn about: when `DatabaseSeeder` ran nothing besides
 * itself while other seeder files exist, every one of them (it ran "successfully" and seeded no
 * rows, which looks like a broken seeder rather than an unregistered one). Empty otherwise.
 */
export function idleSeeders(
  ran: readonly string[],
  files: readonly string[],
): { readonly file: string; readonly name: string }[] {
  if (ran.some((name) => name !== 'DatabaseSeeder')) return []
  return files.map((file) => ({ file, name: seederClassName(file) }))
}

const seedCommand: ContributedCommand = {
  name: 'db:seed',
  description: 'Run the database seeders',
  flags: {
    class: { type: 'string', description: 'Run one seeder, e.g. InvoiceSeeder' },
    tenant: {
      type: 'string',
      description: 'Seed tenant-scoped models for this tenant id (needed in a tenancy app)',
    },
  },
  async run(ctx) {
    const tenantId = tenantFlag(ctx.flags['tenant'])
    const project = await loadFor(ctx)
    const target = migrationTarget(project)
    const raw = project.config['database'] as { seeders?: { directory?: string } } | undefined
    const dir = join(project.root, raw?.seeders?.directory ?? 'database/seeders')
    const cls = str(ctx.flags['class'])
    const file = cls
      ? join(
          dir,
          `${cls
            .replace(/Seeder$/, '')
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .toLowerCase()}.seeder.ts`,
        )
      : join(dir, 'database.seeder.ts')
    if (!existsSync(file)) throw new Error(`Seeder file not found: ${file}`)
    const seeder = await importDefault(file)
    if (!isSeeder(seeder)) throw new Error(`${file} must default-export defineSeeder(...)`)
    const db = await connectDatabase(target.connection)
    try {
      const registry = createModelRegistry(project.models.map((m) => m.definition))
      const ran = await runSeeder(seeder, {
        db,
        registry,
        ids: createUuidV7Generator(),
        ...(tenantId !== undefined ? { tenantId } : {}),
      }).catch((error: unknown) => {
        // A tenancy app seeded without a tenant: say which flag fixes it, not tenant_required.
        if (tenantId === undefined && codeOf(error) === 'tenant_required')
          throw new ValidationError([
            {
              path: ['--tenant'],
              code: 'tenant_required',
              message: `Tenant-scoped models (${registry.all
                .filter((m) => m.options.tenant)
                .map((m) => m.name)
                .join(', ')}) need a tenant: run node strut db:seed --tenant <tenant id>.`,
            },
          ])
        throw error
      })
      for (const name of ran) ctx.out.success(`Seeded ${name}`)
      if (!cls) {
        const unregistered = idleSeeders(ran, await seederFiles(dir))
        if (unregistered.length > 0) {
          ctx.out.warn(
            `DatabaseSeeder ran no other seeder, but ${dir} has ${unregistered.map((u) => u.file).join(', ')}.`,
          )
          ctx.out.warn(
            `Register them in database.seeder.ts, parents before children: ${unregistered
              .map((u) => `await call(${u.name})`)
              .join(
                '; ',
              )} (node strut make:model does this for new models), or run one with node strut db:seed --class ${unregistered[0]?.name ?? ''}.`,
          )
        }
      }
      return { data: { ran } }
    } finally {
      await db.close()
    }
  },
}

const serverFlags = {
  port: { type: 'string', description: 'Port (default: APP_PORT)' },
  host: { type: 'string', description: 'Interface to bind (default 127.0.0.1)' },
  // The debug_in_production boot error tells people to pass this flag, so the server takes it.
  'force-debug': {
    type: 'boolean',
    description: 'Start even with APP_DEBUG=true in production (debug pages stay off)',
  },
} as const

const startCommand: ContributedCommand = {
  name: 'start',
  description: 'Start the app server (the API, and the built UI from dist/web when present)',
  flags: serverFlags,
  async run(ctx) {
    const root = ctx.requireProject().root
    const port = str(ctx.flags['port'])
    const host = str(ctx.flags['host'])
    const appEnv = commandAppEnv(ctx)
    const started = await startProject({
      root,
      ...(appEnv !== undefined ? { env: appEnv } : {}),
      ...(port ? { port: Number(port) } : {}),
      ...(host ? { hostname: host } : {}),
      ...(ctx.flags['force-debug'] === true ? { forceDebug: true } : {}),
    })
    ctx.out.success(`Listening on ${started.server.url} (APP_ENV=${startedEnv(started)})`)
    // Keep the signal's exit code (143 for SIGTERM, ADR-0015), so a process manager can tell a
    // requested stop from a crash; Ctrl+C is reported as 130 by the CLI itself.
    const reason = await stopOnSignals(started)
    return reason === 'SIGTERM' ? { exitCode: exitCodeForStop(reason) } : undefined
  },
}

const devCommand: ContributedCommand = {
  name: 'dev',
  description:
    "Serve the API and the web UI (the project's Vite, with HMR) on one port; restart on app/, config/ or .env changes",
  flags: serverFlags,
  async run(ctx) {
    const root = ctx.requireProject().root
    // Load once in this process: an invalid .env or config fails here as the CLI's config error,
    // and a taken port is reported before the watched child starts (a child that cannot listen
    // would leave Node's watch mode waiting for file changes instead of exiting).
    const project = await loadFor(ctx)
    const appConfig = project.config['app'] as { port?: unknown } | undefined
    const flagPort = str(ctx.flags['port'])
    const port = flagPort
      ? Number(flagPort)
      : typeof appConfig?.port === 'number'
        ? appConfig.port
        : 3000
    await assertCanListen(port, str(ctx.flags['host']) ?? '127.0.0.1')
    const main = fileURLToPath(new URL('./serve-main.mjs', import.meta.url))
    const watch = ['app', 'config', 'strutvane.config.ts', '.env']
      .map((p) => join(root, p))
      .filter((p) => existsSync(p))
      .map((p) => `--watch-path=${p}`)
    const args = [
      ...watch,
      main,
      root,
      str(ctx.flags['port']) ?? '',
      str(ctx.flags['host']) ?? '',
      ctx.flags['force-debug'] === true ? '--force-debug' : '',
    ]
    ctx.out.info('Watching app/, config/ and .env for changes.')
    // The child re-reads nothing on its own: it gets the CLI's APP_ENV explicitly.
    const appEnv = commandAppEnv(ctx)
    const env = appEnv !== undefined ? { ...process.env, APP_ENV: appEnv } : process.env
    const code = await runChild(args, { cwd: root, env, forwardSignals: true })
    return code === 0 ? undefined : { exitCode: code }
  },
}

/**
 * The project's Vite CLI script, when the project has a `vite.config.*` and `vite` installed
 * (resolved from the project root, the same rule `node strut dev` uses; never this package's).
 */
export async function projectViteBin(root: string): Promise<string | undefined> {
  if (findViteConfig(root) === undefined) return undefined
  const manifest = projectPackageManifest(root, 'vite')
  if (manifest === undefined) return undefined
  const pkg = JSON.parse(await readFile(manifest, 'utf8')) as { bin?: unknown }
  const bin =
    typeof pkg.bin === 'string'
      ? pkg.bin
      : typeof pkg.bin === 'object' && pkg.bin !== null
        ? (pkg.bin as Record<string, unknown>)['vite']
        : undefined
  return typeof bin === 'string' ? join(dirname(manifest), bin) : undefined
}

const buildCommand: ContributedCommand = {
  name: 'build',
  description: 'Check that the app boots (models, config, routes) and build the web UI with Vite',
  async run(ctx) {
    const root = ctx.requireProject().root
    const project = await loadFor(ctx)
    createModelRegistry(project.models.map((m) => m.definition))
    ctx.out.success(
      `Project loads: ${project.models.length} model(s), ${project.routes.length} route(s)`,
    )
    const vite = await projectViteBin(root)
    if (vite === undefined) return undefined
    const code = await runChild([vite, 'build'], { cwd: root })
    if (code === 0) ctx.out.success('Web UI built')
    return code === 0 ? undefined : { exitCode: code }
  },
}

/**
 * Run `node <args>` with inherited stdio and resolve with its exit code. Never rejects and never
 * crashes the CLI: a child that cannot start (a missing working directory, EMFILE, EAGAIN) emits
 * `error`, possibly without `exit`; with no listener that is an uncaught exception, and waiting
 * for `exit` alone would hang. Such a child counts as exit code 1. With `forwardSignals`, Ctrl+C
 * and SIGTERM are passed to the child, and the listeners are removed once it is gone.
 */
export function runChild(
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env?: NodeJS.ProcessEnv
    readonly forwardSignals?: boolean
  },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...args], {
      cwd: options.cwd,
      stdio: 'inherit',
      ...(options.env ? { env: options.env } : {}),
    })
    const onSigint = (): void => void child.kill('SIGINT')
    const onSigterm = (): void => void child.kill('SIGTERM')
    if (options.forwardSignals) {
      process.on('SIGINT', onSigint)
      process.on('SIGTERM', onSigterm)
    }
    let settled = false
    const done = (code: number): void => {
      if (settled) return
      settled = true
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      resolve(code)
    }
    child.on('error', () => done(1))
    child.on('exit', (code, signal) =>
      done(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)),
    )
  })
}

/** Every contributed command. Migration-first projects get the v2 database commands. */
export const commands: readonly ContributedCommand[] = Object.freeze([
  dispatchByProject(migrateCommand, migrateV2, MIGRATE_V2_FLAGS),
  dispatchByProject(statusCommand, statusV2, STATUS_V2_FLAGS),
  dispatchByProject(seedCommand, seedV2, SEED_V2_FLAGS),
  ...schemaCommands,
  startCommand,
  devCommand,
  buildCommand,
])

export default commands
