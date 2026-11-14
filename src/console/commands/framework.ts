/**
 * Placeholders for the database commands `@strutvane/framework` provides (docs/09 §4).
 *
 * The CLI never depends on the framework (product packages connect only through contracts and
 * runtime contribution). Instead, the framework contributes `migrate`, `db:seed`, … through its
 * `strutvane.commands` module, and those replace these placeholders automatically. The
 * placeholders exist so `sv help` lists the commands and so running one without the framework
 * explains how to get it instead of saying "unknown command".
 *
 * The destructive ones carry `destructive: true`, so the runner's production guard applies to
 * whichever implementation ends up running.
 *
 * @module
 */
import { type AnyCommand, defineCommand } from '../framework/command.ts'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { readInstalledPackage } from '../project/project.ts'

/** The framework package that provides these commands. */
export const FRAMEWORK_PACKAGE = '@strutvane/framework'

const DATABASE_COMMANDS: readonly [name: string, description: string, destructive: boolean][] = [
  [
    'migrate',
    'Diff models with the database, write a migration, apply it and sync permissions',
    false,
  ],
  ['migrate:status', 'Show applied, pending and drifted migrations', false],
  ['migrate:rollback', 'Roll back the last batch of migrations', true],
  ['migrate:reset', 'Roll back every migration', true],
  ['migrate:fresh', 'Drop all tables and migrate from scratch', true],
  ['migrate:squash', 'Squash applied migrations into a baseline', false],
  ['db:seed', 'Run the database seeders', false],
  ['db:pull', 'Introspect an existing database into model files', false],
  ['db:wipe', 'Drop all tables, views and types', true],
  ['db:shell', 'Open the database shell with the current credentials', false],
  ['db:studio', 'Open a local browser database explorer', false],
  ['db:backup', 'Dump the local database to a file', false],
  ['db:restore', 'Restore the local database from a dump', true],
]

/** Create the placeholder for one framework command. */
export function frameworkPlaceholder(
  name: string,
  description: string,
  destructive: boolean,
): AnyCommand {
  return defineCommand({
    name,
    description,
    placeholder: true,
    destructive,
    allowUnknownFlags: true,
    details: destructive
      ? `Provided by ${FRAMEWORK_PACKAGE}; available once it is installed (sv add framework).
Destructive: type the full name; unless APP_ENV is local, test, testing or development it needs --force --i-understand.`
      : `Provided by ${FRAMEWORK_PACKAGE}; available once it is installed (sv add framework).`,
    run(ctx) {
      const project = ctx.requireProject()
      const installed = readInstalledPackage(project.root, FRAMEWORK_PACKAGE) !== undefined
      throw new CliError(installed ? 'FRAMEWORK_COMMAND_MISSING' : 'FRAMEWORK_REQUIRED', {
        exitCode: EXIT.FAILURE,
        params: { command: name },
      })
    },
  })
}

/** Every framework placeholder. */
export const frameworkPlaceholders: readonly AnyCommand[] = DATABASE_COMMANDS.map(
  ([name, description, destructive]) => frameworkPlaceholder(name, description, destructive),
)
