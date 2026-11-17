/**
 * `node strut security:check`: the deployment checks of blueprint §2.2 in one report, so CI can
 * block a deploy on them.
 *
 * | Check | Fails when |
 * |---|---|
 * | config | the config files can't be loaded (a bad or missing variable) |
 * | debug | `APP_DEBUG=true` with `APP_ENV=production` |
 * | app-key | `APP_KEY` missing, short or malformed |
 * | https | the production `APP_URL` is not https |
 * | cookies | production cookies can't be `Secure` (`APP_URL` over http) |
 * | boot | the app refuses to boot (CORS `*` with credentials, unsafe headers, a bad route…) |
 * | csp | (warning) CSP off, or scripts allowed from `'unsafe-inline'`, `*`, `data:`… |
 * | csrf-exceptions | (warning) an exception pattern that matches every path |
 * | cors | (warning) CORS open to any origin |
 * | dev-tools | `/_…` developer routes without auth (a failure in production, a warning elsewhere) |
 * | npm-audit | `--audit` only: high or critical advisories |
 *
 * `npm audit` needs the network, so it is opt-in. It runs npm's own `npm-cli.js` with the current
 * Node binary (an absolute path found next to Node, or `npm_execpath` when it names
 * `npm-cli.js`), never a bare `npm` looked up on PATH or in the project folder (spike 12 review
 * F-25).
 *
 * Exit code 3 when any check fails (the CLI's code for failed checks, like `doctor`).
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Application } from '../../../foundation/application.ts'
import type { ConfigRepository } from '../../../foundation/config.ts'
import { loadEnvSource } from '../../../foundation/env.ts'
import { keyProblem } from '../../../security/keyring.ts'
import { cspWeakness } from '../../../security/secure-headers.ts'
import type { AnyCommand, CommandContext } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import type { CliServices } from '../../framework/services.ts'
import { type AppCommandDeps, appRoot, defineAppCommand, plural } from './support.ts'

/**
 * One finding of `security:check`.
 *
 * @example
 * const finding: SecurityFinding = { check: 'https', status: 'fail', detail: 'production APP_URL is not https' }
 */
export interface SecurityFinding {
  readonly check: string
  readonly status: 'pass' | 'warn' | 'fail' | 'skip'
  readonly detail: string
}

/**
 * Where npm's CLI script is: `npm_execpath` when it names `npm-cli.js`, else next to the Node
 * binary (Windows: `<node dir>/node_modules/npm`; elsewhere: `<prefix>/lib/node_modules/npm`).
 * `undefined` when it can't be found.
 *
 * @example
 * npmCliPath({ env: process.env, execPath: process.execPath, platform: process.platform })
 */
export function npmCliPath(
  services: Pick<CliServices, 'env' | 'execPath' | 'platform'>,
): string | undefined {
  const fromEnv = services.env['npm_execpath']
  const nodeDir = dirname(services.execPath)
  const candidates = [
    ...(fromEnv !== undefined && basename(fromEnv) === 'npm-cli.js' ? [fromEnv] : []),
    services.platform === 'win32'
      ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/** Run `npm audit` and turn its counts into a finding. */
async function auditFinding(ctx: CommandContext, root: string): Promise<SecurityFinding> {
  const cli = npmCliPath(ctx.services)
  if (cli === undefined)
    return {
      check: 'npm-audit',
      status: 'warn',
      detail: 'could not run: npm was not found next to Node',
    }
  const result = await ctx.services.spawn(
    ctx.services.execPath,
    [cli, 'audit', '--json', '--omit=dev'],
    { cwd: root },
  )
  let report: unknown
  try {
    report = JSON.parse(result.stdout)
  } catch {
    return {
      check: 'npm-audit',
      status: 'warn',
      detail: 'could not run: npm audit did not return JSON (offline?)',
    }
  }
  const metadata = field(report, 'metadata')
  const counts = field(metadata, 'vulnerabilities')
  if (counts === undefined)
    return {
      check: 'npm-audit',
      status: 'warn',
      detail: 'could not run: npm audit returned no counts',
    }
  const high = count(field(counts, 'high'))
  const critical = count(field(counts, 'critical'))
  return high + critical === 0
    ? { check: 'npm-audit', status: 'pass', detail: 'no high or critical advisories' }
    : {
        check: 'npm-audit',
        status: 'fail',
        detail: `${critical} critical and ${high} high advisories; run npm audit for details`,
      }
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? (value as Record<string, unknown>)[name]
    : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** A config value as text, falling back to the environment the app reads. */
function setting(config: ConfigRepository, path: string, fallback: string | undefined): string {
  return config.has(path) ? String(config.get(path)) : (fallback ?? '')
}

/**
 * Run every check against a loaded (not yet booted) app. Boots it on the way (with
 * `--force-debug` when debug-in-production is the only reason it would refuse: that is already a
 * finding, and the other checks still need a booted app).
 *
 * @example
 * const findings = await securityFindings(app)
 */
export async function securityFindings(app: Application): Promise<SecurityFinding[]> {
  let config: ConfigRepository
  try {
    config = app.loadFreshConfig()
  } catch (error) {
    return [{ check: 'config', status: 'fail', detail: messageOf(error) }]
  }
  const source = loadEnvSource(app.basePath, undefined)
  const environment = setting(config, 'app.env', source['APP_ENV'] ?? 'production')
  const production = environment === 'production'
  const debug = config.has('app.debug')
    ? config.get('app.debug') === true
    : source['APP_DEBUG'] === 'true'
  const appUrl = setting(config, 'app.url', source['APP_URL'] ?? 'http://localhost')
  const https = appUrl.startsWith('https://')
  const keyIssue = keyProblem(
    config.has('app.key') ? String(config.get('app.key') ?? '') : source['APP_KEY'],
  )
  const findings: SecurityFinding[] = [
    debug && production
      ? {
          check: 'debug',
          status: 'fail',
          detail: 'APP_DEBUG=true with APP_ENV=production. Set APP_DEBUG=false.',
        }
      : {
          check: 'debug',
          status: 'pass',
          detail: `APP_DEBUG=${String(debug)}, APP_ENV=${environment}`,
        },
    keyIssue === undefined
      ? { check: 'app-key', status: 'pass', detail: 'APP_KEY is set and at least 32 bytes' }
      : {
          check: 'app-key',
          status: 'fail',
          detail: `APP_KEY ${keyIssue}. Run node strut key:generate.`,
        },
    !production
      ? { check: 'https', status: 'pass', detail: `not production (${appUrl})` }
      : https
        ? { check: 'https', status: 'pass', detail: appUrl }
        : {
            check: 'https',
            status: 'fail',
            detail: `production APP_URL is not https (${appUrl}).`,
          },
    production && !https
      ? {
          check: 'cookies',
          status: 'fail',
          detail:
            "cookies can't be Secure while APP_URL is http; session and bypass cookies would travel in clear text.",
        }
      : {
          check: 'cookies',
          status: 'pass',
          detail: production
            ? 'Secure, HttpOnly, SameSite=Lax'
            : 'HttpOnly, SameSite=Lax (Secure in production)',
        },
  ]
  if (debug && production) app.forceDebug()
  try {
    await app.boot()
  } catch (error) {
    findings.push({
      check: 'boot',
      status: 'fail',
      detail: `the app refuses to boot: ${messageOf(error)}`,
    })
    return findings
  }
  findings.push(
    {
      check: 'boot',
      status: 'pass',
      detail: 'every boot-time check passed (CORS, headers, hosts, proxies, limits, routes)',
    },
    ...bootedFindings(app, production),
  )
  return findings
}

/** The checks that need the booted app's settings and routes. */
function bootedFindings(app: Application, production: boolean): SecurityFinding[] {
  const security = app.security
  const weakness = cspWeakness(security.headers.csp)
  const everything = security.csrf.except.filter((pattern) =>
    /^\*+$/.test(pattern.replaceAll('/', '')),
  )
  const exposed = [...app.routes, ...app.fallbacks]
    .filter((route) =>
      app.securityProfile(route).warnings.includes('developer tool route without auth'),
    )
    .map((route) => route.uri)
  return [
    weakness === undefined
      ? { check: 'csp', status: 'pass', detail: 'nonce-based script-src' }
      : { check: 'csp', status: 'warn', detail: weakness },
    everything.length === 0
      ? {
          check: 'csrf-exceptions',
          status: 'pass',
          detail: `${plural(security.csrf.except.length, 'exception pattern')}`,
        }
      : {
          check: 'csrf-exceptions',
          status: 'warn',
          detail: `"${everything.join('", "')}" turns CSRF off for every path`,
        },
    security.cors.origins.includes('*')
      ? { check: 'cors', status: 'warn', detail: 'CORS allows any origin (without credentials)' }
      : {
          check: 'cors',
          status: 'pass',
          detail: security.cors.enabled ? `allowlist: ${security.cors.origins.join(', ')}` : 'off',
        },
    exposed.length === 0
      ? { check: 'dev-tools', status: 'pass', detail: 'no /_ routes without auth' }
      : {
          check: 'dev-tools',
          status: production ? 'fail' : 'warn',
          detail: `exposed without auth: ${exposed.join(', ')}`,
        },
  ]
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n').join(' ')
}

const MARK: Readonly<Record<SecurityFinding['status'], string>> = {
  pass: '✔',
  warn: '!',
  fail: '✖',
  skip: '·',
}

/**
 * The `security:check` command.
 *
 * @example
 * securityCheckCommand(DEFAULT_APP_DEPS)
 */
export function securityCheckCommand(deps: AppCommandDeps): AnyCommand {
  return defineAppCommand({
    name: 'security:check',
    description: 'Check the configuration for common security mistakes',
    details:
      'Exit code 3 when any check fails, so CI can block a deploy. --audit also runs npm audit (needs the network).',
    requiresProject: false,
    flags: { audit: { type: 'boolean', description: 'Also run npm audit (needs the network)' } },
    examples: ['node strut security:check', 'node strut security:check --audit --json'],
    async run(ctx) {
      const root = appRoot(ctx)
      const app = await deps.load(root)
      let findings: SecurityFinding[]
      try {
        findings = await securityFindings(app)
      } finally {
        if (app.state === 'booted') await app.shutdown()
      }
      findings.push(
        ctx.flags.audit === true
          ? await auditFinding(ctx, root)
          : { check: 'npm-audit', status: 'skip', detail: 'run with --audit (needs the network)' },
      )
      const failed = findings.filter((finding) => finding.status === 'fail').length
      const warned = findings.filter((finding) => finding.status === 'warn').length
      const { out } = ctx
      out.table(
        ['', 'Check', 'Detail'],
        findings.map((finding) => [MARK[finding.status], finding.check, finding.detail]),
      )
      out.line()
      if (failed === 0) out.success(`No failures, ${plural(warned, 'warning')}.`)
      else
        out.line(
          `  ${out.style.red('✖')} ${plural(failed, 'failure')}, ${plural(warned, 'warning')}.`,
        )
      return {
        data: { passed: failed === 0, findings },
        ...(failed === 0 ? {} : { exitCode: EXIT.VALIDATION }),
      }
    },
  })
}
