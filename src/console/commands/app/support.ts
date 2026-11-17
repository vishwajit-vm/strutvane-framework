/**
 * What the app commands (`node strut optimize`, `down`, `route:list`…) share: finding the app,
 * loading and booting it, and turning the framework's friendly `BootError`s into CLI failures.
 *
 * **Dependency injection instead of globals:** every command that needs the application gets it
 * through {@link AppCommandDeps}. `node strut` uses the real loader (it imports
 * `bootstrap/app.ts`); tests pass a loader that returns an app they built, with a test clock and
 * a memory logger, so every command runs in-process and deterministically.
 *
 * @module
 */
import { dirname, resolve } from 'node:path'
import type { Application } from '../../../foundation/application.ts'
import { isBootError } from '../../../foundation/boot-error.ts'
import type { ArgMap, CommandContext, CommandDefinition, FlagMap } from '../../framework/command.ts'
import { CliError } from '../../framework/errors.ts'
import { EXIT, type ExitCode } from '../../framework/exit-codes.ts'
import {
  isForbiddenProjectDir,
  isOwnedByCurrentUser,
  processBoundary,
} from '../../project/boundary.ts'
import { isAppRoot } from '../../project/project.ts'

/**
 * What the app commands need from the outside world.
 *
 * @example
 * const deps: AppCommandDeps = { load: async () => myTestApp }
 */
export interface AppCommandDeps {
  /** Import the app at `root` (default: `loadApplication`, which imports `bootstrap/app.ts`). */
  readonly load: (root: string) => Promise<Application>
}

/**
 * The real dependencies `node strut` uses. The loader is imported on first use: the application
 * core is large, and `node strut help` or `node strut up` should not pay for it.
 *
 * @example
 * createAppCommands(DEFAULT_APP_DEPS)
 */
export const DEFAULT_APP_DEPS: AppCommandDeps = Object.freeze({
  load: async (root: string): Promise<Application> =>
    (await import('../../../foundation/load.ts')).loadApplication(root),
})

/**
 * The `--force-debug` flag every command that boots the app accepts: boot even with
 * `APP_DEBUG=true` in production, which the boot guard otherwise refuses (CONSISTENCY #19).
 *
 * @example
 * flags: { ...BOOT_FLAGS, path: { type: 'string' } }
 */
export const BOOT_FLAGS: {
  readonly 'force-debug': { readonly type: 'boolean'; readonly description: string }
} = {
  'force-debug': {
    type: 'boolean',
    description: 'Boot even with APP_DEBUG=true in production (otherwise refused)',
  },
}

/** `true` when a folder holds an app (one rule for the CLI's project lookup and these commands). */
export { isAppRoot } from '../../project/project.ts'

/**
 * Like {@link appRoot}, but `undefined` instead of an error when there is no app.
 *
 * @example
 * findAppRoot(ctx) ?? ctx.requireProject().root
 */
export function findAppRoot(ctx: Pick<CommandContext, 'cwd' | 'project'>): string | undefined {
  if (ctx.project !== undefined && isAppRoot(ctx.project.root)) return ctx.project.root
  const facts = processBoundary()
  for (let dir = resolve(ctx.cwd); !isForbiddenProjectDir(dir, facts); dir = dirname(dir)) {
    if (isAppRoot(dir)) return isOwnedByCurrentUser(dir, facts) ? dir : undefined
  }
  return undefined
}

/**
 * The app's root: the CLI's project when it is an app, else the nearest folder at or above the
 * working directory with `bootstrap/app.ts` (under the same boundary rules as project lookup:
 * never a drive root, the temp folder or a folder above home; on POSIX, owned by you).
 *
 * @example
 * const root = appRoot(ctx) // '/srv/blog'
 */
export function appRoot(ctx: Pick<CommandContext, 'cwd' | 'project'>): string {
  const found = findAppRoot(ctx)
  if (found !== undefined) return found
  throw commandError(
    'app_not_found',
    `No Strutvane app found at or above ${ctx.cwd}.`,
    'Run node strut from the app root (the folder with bootstrap/app.ts), or pass --cwd <path>.',
    EXIT.USAGE,
  )
}

/**
 * Load the app at {@link appRoot}, boot it (with `--force-debug` when given), run `work`, and
 * always shut the app down afterwards so open connections never keep the command alive.
 *
 * @example
 * return withBootedApp(ctx, deps, (app) => ({ data: { routes: app.routes.length } }))
 */
export async function withBootedApp<TResult>(
  ctx: Pick<CommandContext, 'cwd' | 'project'> & {
    readonly flags: { readonly 'force-debug'?: boolean | undefined }
  },
  deps: AppCommandDeps,
  work: (app: Application) => TResult | Promise<TResult>,
): Promise<TResult> {
  const app = await deps.load(appRoot(ctx))
  if (ctx.flags['force-debug'] === true) app.forceDebug()
  try {
    await app.boot()
    return await work(app)
  } finally {
    if (app.state === 'booted') await app.shutdown()
  }
}

/**
 * A CLI failure with a lowercase code, a message and a fix-it hint. The CLI renders `detail`, so
 * the hint goes on its own line after an arrow, like a `BootError`.
 *
 * @example
 * throw commandError('file_exists', '.env already exists.', 'Add --force to replace it.', EXIT.CONFLICT)
 */
export function commandError(
  code: string,
  message: string,
  hint: string,
  exitCode: ExitCode = EXIT.FAILURE,
): CliError {
  return new CliError(code, {
    exitCode,
    params: { detail: `${message}\n  → ${hint}` },
    data: { code, message, hint },
  })
}

/**
 * Declare an app command: `defineCommand`, plus friendly failures. A `BootError` (bad config, a
 * missing binding, a weak key, an unknown cache store) becomes a CLI failure with its message and
 * hint and exit code 3 (configuration), instead of an "unexpected error".
 *
 * @example
 * export const upCommand = defineAppCommand({ name: 'up', description: '…', run: () => undefined })
 */
export function defineAppCommand<
  const F extends FlagMap = Record<never, never>,
  const A extends ArgMap = Record<never, never>,
>(definition: CommandDefinition<F, A>): CommandDefinition<F, A> {
  return {
    ...definition,
    async run(ctx) {
      try {
        return await definition.run(ctx)
      } catch (error) {
        if (!isBootError(error)) throw error
        throw commandError(error.code, error.message, error.hint, EXIT.VALIDATION)
      }
    },
  }
}

/**
 * `1 route`, `2 routes`.
 *
 * @example
 * plural(2, 'listener') // '2 listeners'
 */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}
