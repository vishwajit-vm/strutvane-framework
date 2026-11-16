/**
 * `node strut down` and `up`: maintenance mode, as in Laravel.
 *
 * ```
 * node strut down --retry=60 --refresh=15
 * node strut down --with-secret                 # prints the bypass URL once
 * node strut down --secret=team-preview-2026    # your own secret (8-128 URL-safe characters)
 * node strut down --redirect=/status            # same-origin paths only
 * node strut down --render=maintenance.html     # resources/views/maintenance.html, pre-rendered
 * node strut up
 * ```
 *
 * `down` boots the app (it needs the keyring to hash the secret and `APP_URL` to check the
 * redirect); every check runs before anything is written, so a refused option leaves the app up.
 * `up` only removes the state file: it works even when the code can't boot.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import {
  MAINTENANCE_SECRET,
  maintenanceRedirect,
  secretHash,
} from '../../../maintenance/maintenance.ts'
import { readMaintenancePage } from '../../../maintenance/page.ts'
import {
  clearMaintenance,
  type MaintenanceState,
  writeMaintenance,
} from '../../../maintenance/state.ts'
import { KeyringToken } from '../../../security/keyring.ts'
import type { AnyCommand } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import {
  type AppCommandDeps,
  appRoot,
  BOOT_FLAGS,
  commandError,
  defineAppCommand,
  withBootedApp,
} from './support.ts'

/** Whole seconds, up to a week (what the state file accepts back). */
function seconds(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = /^\d{1,6}$/.test(value) ? Number(value) : Number.NaN
  if (Number.isInteger(parsed) && parsed <= 7 * 24 * 60 * 60) return parsed
  throw commandError(
    'invalid_option',
    `--${name} must be a whole number of seconds, at most a week (got "${value}").`,
    `Example: --${name}=60`,
    EXIT.USAGE,
  )
}

/**
 * The `down` and `up` commands.
 *
 * @example
 * maintenanceCommands(DEFAULT_APP_DEPS)
 */
export function maintenanceCommands(deps: AppCommandDeps): readonly AnyCommand[] {
  return [
    defineAppCommand({
      name: 'down',
      description: 'Put the application into maintenance mode',
      details: [
        'Every process serving the app answers 503 from its next request; /up stays healthy.',
        'The bypass secret is never stored (only an HMAC under an APP_KEY subkey), and a new',
        '`down` invalidates every earlier bypass cookie.',
      ].join('\n'),
      requiresProject: false,
      flags: {
        ...BOOT_FLAGS,
        secret: {
          type: 'string',
          valueName: '<secret>',
          description: 'A secret path that bypasses maintenance mode (8-128 URL-safe characters)',
        },
        'with-secret': {
          type: 'boolean',
          description: 'Generate a random bypass secret and print the bypass URL once',
        },
        retry: { type: 'string', valueName: '<seconds>', description: 'The Retry-After header' },
        refresh: { type: 'string', valueName: '<seconds>', description: 'The Refresh header' },
        redirect: {
          type: 'string',
          valueName: '<path>',
          description: 'Redirect every request to this same-origin path',
        },
        render: {
          type: 'string',
          valueName: '<file>',
          description: 'An .html file in resources/views to show browsers',
        },
      },
      examples: [
        'node strut down --retry=60',
        'node strut down --with-secret',
        'node strut down --redirect=/status',
        'node strut down --render=maintenance.html',
      ],
      async run(ctx) {
        const { flags } = ctx
        if (flags.secret !== undefined && flags['with-secret'] === true)
          throw commandError(
            'invalid_option',
            'Use --secret or --with-secret, not both.',
            '--with-secret generates a strong secret for you.',
            EXIT.USAGE,
          )
        if (flags.secret !== undefined && !MAINTENANCE_SECRET.test(flags.secret))
          throw commandError(
            'invalid_option',
            '--secret must be 8 to 128 letters, digits, "-" or "_".',
            'Or use --with-secret to generate a strong one.',
            EXIT.USAGE,
          )
        const retry = seconds('retry', flags.retry)
        const refresh = seconds('refresh', flags.refresh)
        const root = appRoot(ctx)
        const html =
          flags.render === undefined ? undefined : readMaintenancePage(root, flags.render)
        const secret =
          flags['with-secret'] === true ? randomBytes(24).toString('base64url') : flags.secret
        const result = await withBootedApp(ctx, deps, (app) => {
          const appUrl = app.configRepository.string('app.url', 'http://localhost')
          const redirect =
            flags.redirect === undefined ? undefined : maintenanceRedirect(flags.redirect, appUrl)
          if (flags.redirect !== undefined && redirect === undefined)
            throw commandError(
              'unsafe_redirect',
              `--redirect must be a path on this site, such as /status (got "${flags.redirect}").`,
              'Absolute URLs, "//host" and encoded variants are refused, so maintenance mode can never send visitors elsewhere.',
              EXIT.USAGE,
            )
          const state: MaintenanceState = {
            since: Math.floor(ctx.services.clock.now() / 1000),
            ...(retry === undefined ? {} : { retry }),
            ...(refresh === undefined ? {} : { refresh }),
            ...(secret === undefined
              ? {}
              : { secretHash: secretHash(app.make(KeyringToken), secret) }),
            ...(redirect === undefined ? {} : { redirect }),
            ...(html === undefined ? {} : { html }),
          }
          writeMaintenance(app.basePath, state)
          return { appUrl, redirect }
        })
        ctx.out.success('The application is now in maintenance mode.')
        const bypassUrl =
          secret === undefined ? undefined : `${result.appUrl.replace(/\/+$/, '')}/${secret}`
        if (bypassUrl !== undefined)
          ctx.out.line(
            `  Bypass it by visiting ${bypassUrl} (shown once; the secret is not stored).`,
          )
        return {
          data: {
            down: true,
            ...(retry === undefined ? {} : { retry }),
            ...(refresh === undefined ? {} : { refresh }),
            ...(result.redirect === undefined ? {} : { redirect: result.redirect }),
            rendered: html !== undefined,
            ...(bypassUrl === undefined ? {} : { bypassUrl }),
          },
        }
      },
    }),
    defineAppCommand({
      name: 'up',
      description: 'Bring the application out of maintenance mode',
      requiresProject: false,
      examples: ['node strut up'],
      run(ctx) {
        const removed = clearMaintenance(appRoot(ctx))
        if (removed) ctx.out.success('The application is now live.')
        else ctx.out.line('  The application was not in maintenance mode.')
        return { data: { up: true, wasDown: removed } }
      },
    }),
  ]
}
