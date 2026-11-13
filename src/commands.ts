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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUuidV7Generator } from '@strutvane/core'
import { connectDatabase } from './database/connect.ts'
import { answersResolver } from './migrations/files.ts'
import type { RenameDecision } from './migrations/planner.ts'
import { createModelRegistry } from './model/registry.ts'
import { migrateProject, migrationTarget, projectMigrationStatus } from './runtime/migrations.ts'
import { importDefault, loadProject } from './runtime/project.ts'
import { isSeeder, runSeeder } from './runtime/seeders.ts'
import { startServer, stopOnSignals } from './runtime/server.ts'

/** The parts of the CLI's command context these commands use. */
export interface CommandContextLike {
  readonly flags: Readonly<Record<string, string | boolean | string[] | undefined>>
  requireProject(): { readonly root: string }
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

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []

const migrateCommand: ContributedCommand = {
  name: 'migrate',
  description: 'Diff models with the database, write a migration and apply it',
  flags: {
    name: { type: 'string', description: 'Name for the generated migration (default "auto")' },
    pretend: { type: 'boolean', description: 'Write the migration but apply nothing' },
    'allow-destructive': { type: 'boolean', description: 'Allow dropping tables or columns' },
    rename: {
      type: 'string',
      multiple: true,
      description: 'Confirm a rename: table=new or table.column=new',
    },
    separate: { type: 'string', multiple: true, description: 'Reject a rename: old=new' },
  },
  async run(ctx) {
    const project = await loadProject(ctx.requireProject().root)
    const answers = renameAnswers(list(ctx.flags['rename']), list(ctx.flags['separate']))
    const result = await migrateProject(project, {
      ...(str(ctx.flags['name']) ? { name: str(ctx.flags['name']) as string } : {}),
      ...(ctx.flags['pretend'] === true ? { pretend: true } : {}),
      ...(ctx.flags['allow-destructive'] === true ? { allowDestructive: true } : {}),
      ...(Object.keys(answers).length > 0 ? { resolveRename: answersResolver(answers) } : {}),
    })
    if (result.created) ctx.out.success(`Created migration ${result.created}.sql`)
    for (const name of result.applied) ctx.out.success(`Applied ${name}`)
    if (!result.created && result.applied.length === 0) ctx.out.success('Nothing to migrate.')
    return { data: result }
  },
}

const statusCommand: ContributedCommand = {
  name: 'migrate:status',
  description: 'Show applied, pending and drifted migrations',
  async run(ctx) {
    const project = await loadProject(ctx.requireProject().root)
    const status = await projectMigrationStatus(project)
    ctx.out.table(
      ['Migration', 'Status'],
      [
        ...status.applied.map((a) => [a.name, `applied (batch ${a.batch})`]),
        ...status.pending.map((p) => [p, 'pending']),
        ...status.drift.map((d) => [d.name, `drift: ${d.kind}`]),
      ],
    )
    return status.drift.length > 0 ? { exitCode: 1, data: status } : { data: status }
  },
}

const seedCommand: ContributedCommand = {
  name: 'db:seed',
  description: 'Run the database seeders',
  flags: { class: { type: 'string', description: 'Run one seeder, e.g. InvoiceSeeder' } },
  async run(ctx) {
    const project = await loadProject(ctx.requireProject().root)
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
      const ran = await runSeeder(seeder, {
        db,
        registry: createModelRegistry(project.models.map((m) => m.definition)),
        ids: createUuidV7Generator(),
      })
      for (const name of ran) ctx.out.success(`Seeded ${name}`)
      return { data: { ran } }
    } finally {
      await db.close()
    }
  },
}

const serverFlags = {
  port: { type: 'string', description: 'Port (default: APP_PORT)' },
  host: { type: 'string', description: 'Interface to bind (default 127.0.0.1)' },
} as const

const startCommand: ContributedCommand = {
  name: 'start',
  description: 'Start the app server',
  flags: serverFlags,
  async run(ctx) {
    const root = ctx.requireProject().root
    const port = str(ctx.flags['port'])
    const host = str(ctx.flags['host'])
    const started = await startServer({
      root,
      ...(port ? { port: Number(port) } : {}),
      ...(host ? { hostname: host } : {}),
    })
    ctx.out.success(`Listening on ${started.server.url} (APP_ENV=${started.project.env})`)
    await stopOnSignals(started)
    return undefined
  },
}

const devCommand: ContributedCommand = {
  name: 'dev',
  description: 'Start the app server and restart it when app/, config/ or .env change',
  flags: serverFlags,
  async run(ctx) {
    const root = ctx.requireProject().root
    const main = fileURLToPath(new URL('./serve-main.mjs', import.meta.url))
    const watch = ['app', 'config', 'strutvane.config.ts', '.env']
      .map((p) => join(root, p))
      .filter((p) => existsSync(p))
      .map((p) => `--watch-path=${p}`)
    const args = [...watch, main, root, str(ctx.flags['port']) ?? '', str(ctx.flags['host']) ?? '']
    ctx.out.info('Watching app/, config/ and .env for changes.')
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' })
      const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
      process.on('SIGINT', forward('SIGINT'))
      process.on('SIGTERM', forward('SIGTERM'))
      child.on('exit', (exitCode) => resolve(exitCode ?? 0))
    })
    return code === 0 ? undefined : { exitCode: code }
  },
}

const buildCommand: ContributedCommand = {
  name: 'build',
  description: 'Check that the app boots (models, config, routes) and build the web UI with Vite',
  async run(ctx) {
    const root = ctx.requireProject().root
    const project = await loadProject(root)
    createModelRegistry(project.models.map((m) => m.definition))
    ctx.out.success(
      `Project loads: ${project.models.length} model(s), ${project.routes.length} route(s)`,
    )
    const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
    if (!existsSync(join(root, 'vite.config.ts')) || !existsSync(vite)) return undefined
    const code = await new Promise<number>((resolve) => {
      spawn(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' }).on('exit', (c) =>
        resolve(c ?? 1),
      )
    })
    if (code === 0) ctx.out.success('Web UI built')
    return code === 0 ? undefined : { exitCode: code }
  },
}

/** Every contributed command. */
export const commands: readonly ContributedCommand[] = Object.freeze([
  migrateCommand,
  statusCommand,
  seedCommand,
  startCommand,
  devCommand,
  buildCommand,
])

export default commands
