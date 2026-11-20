/**
 * `node strut models`, `node strut permissions` and the `doctor` app check for an application
 * (`bootstrap/app.ts`). The v1 versions compile a registry from `strutvane.config.ts` projects'
 * `defineModel` files; an application has none, so they failed with `unknown_model` or
 * `unexpected_default_export` (acceptance FW-11). Here the sources are the application's own:
 *
 * - **models:** `.strutvane/resources.json` (written by `node strut migrate` from the migrations;
 *   read, never imported), with the model and policy files found next to it. No database, no
 *   `.env` and no boot needed, so it works on a fresh clone.
 * - **permissions:** the booted app: abilities defined with `defineAbility()`, every model's
 *   policy (registered or discovered in `app/policies`) and its abilities, and the routes that use
 *   `can:<ability>`. A model without a policy is listed as denied: Strutvane denies by default.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PolicyRegistryToken, policyFile } from '../../../auth/policies.ts'
import type { Application } from '../../../foundation/application.ts'
import { isBootError } from '../../../foundation/boot-error.ts'
import { readAppMetadata } from '../../../http/app/manifest.ts'
import type { AppMetadata } from '../../../schema/generate/metadata.ts'
import { kebabCase } from '../../../support/str.ts'
import type { CommandContext } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import { type AppCommandDeps, commandError } from './support.ts'

/** One model, as `node strut models` reports it. */
export interface AppModelRow {
  readonly name: string
  readonly table: string
  /** `app/models/<name>.ts` when it exists, else `null`. */
  readonly file: string | null
  /** `app/policies/<name>.policy.ts` when it exists, else `null` (every action is denied). */
  readonly policy: string | null
  readonly fields: readonly {
    readonly name: string
    readonly type: string
    readonly target: string | null
  }[]
  readonly softDeletes: boolean
  readonly tenant: boolean
}

/**
 * The app's models from `.strutvane/resources.json`. Throws a CLI failure with the fix when the
 * file is missing (no migration has run yet).
 *
 * @example
 * appModels('/srv/northwind').map((m) => m.name) // ['Customer', 'Order']
 */
export function appModels(root: string): AppModelRow[] {
  const metadata = requireMetadata(root)
  const relative = (path: string | undefined): string | null =>
    path === undefined ? null : path.slice(root.length + 1).replace(/\\/g, '/')
  return metadata.resources.map((resource) => {
    const model = join('app', 'models', `${kebabCase(resource.model)}.ts`)
    return {
      name: resource.model,
      table: resource.table,
      file: existsSync(join(root, model)) ? model.replace(/\\/g, '/') : null,
      policy: relative(policyFile(root, resource.model)),
      fields: resource.fields
        .filter((field) => !field.hidden)
        .map((field) => ({
          name: field.name,
          type: field.kind,
          target: field.references ?? null,
        })),
      softDeletes: resource.softDeletes,
      tenant: resource.tenant !== undefined,
    }
  })
}

/** `node strut models` for an application. */
export function runAppModels(
  ctx: Pick<CommandContext, 'out'>,
  root: string,
  only: string | undefined,
): { readonly data: { readonly models: readonly AppModelRow[] } } {
  const models = appModels(root).filter((model) => only === undefined || model.name === only)
  const { out } = ctx
  models.forEach((model, index) => {
    if (index > 0) out.line()
    const flags = [model.tenant ? 'tenant' : '', model.softDeletes ? 'soft deletes' : '']
      .filter((flag) => flag !== '')
      .join(', ')
    out.line(
      `${out.style.bold(model.name)} ${out.style.dim(model.file ?? `(table ${model.table}, no model file)`)}${flags === '' ? '' : ` (${flags})`}`,
    )
    out.line(
      `  policy: ${model.policy ?? out.style.yellow('none: every action is denied (node strut make:policy)')}`,
    )
    out.table(
      ['  Field', 'Type', 'Related'],
      model.fields.map((field) => [`  ${field.name}`, field.type, field.target ?? '']),
    )
  })
  if (models.length === 0) out.line(out.style.dim('No models yet: run node strut make:migration.'))
  return { data: { models } }
}

/** One line of `node strut permissions`. */
export interface AppPermissionRow {
  /** `manage-customers` (an ability) or `Customer.update` (a policy ability). */
  readonly permission: string
  readonly kind: 'ability' | 'policy' | 'denied'
  /** Where it is defined, or why it is denied. */
  readonly source: string
  /** Routes that require it through `can:<ability>`. */
  readonly routes: readonly string[]
}

/** The abilities a policy object answers (its own and inherited methods, minus `before`). */
function policyAbilities(policy: object): string[] {
  const names = new Set<string>()
  for (let proto: object | null = policy; proto !== null && proto !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(proto))
      if (
        name !== 'constructor' &&
        name !== 'before' &&
        typeof (policy as Record<string, unknown>)[name] === 'function'
      )
        names.add(name)
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return [...names].sort()
}

/**
 * Every permission a booted app uses: its abilities (with the routes that require them) and each
 * model's policy abilities. Models come from `.strutvane/resources.json` when present.
 *
 * @example
 * (await appPermissions(app)).map((row) => row.permission) // ['manage-customers', 'Customer.viewAny', …]
 */
export async function appPermissions(app: Application): Promise<AppPermissionRow[]> {
  const rows: AppPermissionRow[] = []
  const usedBy = new Map<string, string[]>()
  for (const route of app.routes)
    for (const reference of app.routeMiddleware(route).references)
      if (reference.alias === 'can' && reference.params[0] !== undefined)
        usedBy.set(reference.params[0], [
          ...(usedBy.get(reference.params[0]) ?? []),
          `${route.methods.join('|')} ${route.uri}`,
        ])
  for (const ability of [...app.middleware.abilityNames].sort())
    rows.push({
      permission: ability,
      kind: 'ability',
      source: 'defineAbility (bootstrap/app.ts)',
      routes: usedBy.get(ability) ?? [],
    })
  const registry = app.make(PolicyRegistryToken)
  for (const resource of readAppMetadata(app.basePath)?.resources ?? []) {
    const target = { name: resource.model }
    const policy = await registry.discover(target)
    if (policy === undefined) {
      rows.push({
        permission: `${resource.model}.*`,
        kind: 'denied',
        source: `no policy: create app/policies/${kebabCase(resource.model)}.policy.ts`,
        routes: [],
      })
      continue
    }
    const file = policyFile(app.basePath, resource.model)
    const source =
      file === undefined
        ? 'registered in a provider'
        : `app/policies/${kebabCase(resource.model)}.policy.ts`
    for (const ability of policyAbilities(policy))
      rows.push({ permission: `${resource.model}.${ability}`, kind: 'policy', source, routes: [] })
  }
  return rows
}

/** `node strut permissions` for a booted application. */
export async function runAppPermissions(
  ctx: Pick<CommandContext, 'out'>,
  app: Application,
  only: string | undefined,
): Promise<{
  readonly data: {
    readonly permissions: readonly string[]
    readonly rows: readonly AppPermissionRow[]
  }
}> {
  const rows = (await appPermissions(app)).filter(
    (row) => only === undefined || row.permission.startsWith(`${only}.`),
  )
  const { out } = ctx
  out.table(
    ['Permission', 'Kind', 'Source', 'Routes'],
    rows.map((row) => [
      row.permission,
      row.kind === 'denied' ? out.style.yellow(row.kind) : row.kind,
      row.source,
      row.routes.join(', '),
    ]),
  )
  return { data: { permissions: rows.map((row) => row.permission), rows } }
}

function requireMetadata(root: string): AppMetadata {
  const metadata = readAppMetadata(root)
  if (metadata !== undefined) return metadata
  throw commandError(
    'no_resources_json',
    `${join(root, '.strutvane', 'resources.json')} is missing or unreadable.`,
    'Run node strut migrate (or node strut sync, which needs no database) to generate it from database/migrations.',
    EXIT.VALIDATION,
  )
}

/** One `node strut doctor` finding (the same shape as doctor's own checks). */
export interface AppDoctorCheck {
  readonly id: string
  readonly status: 'ok' | 'warn' | 'fail'
  readonly message: string
  readonly hint?: string
}

/** Installed add-ons that ship a provider (`./provider` export) an app registers itself. */
function providerPackages(root: string, dependencies: readonly string[]): string[] {
  return dependencies.filter((name) => {
    if (!name.startsWith('@strutvane/') || name === '@strutvane/framework') return false
    const manifest = join(root, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(manifest)) return false
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { exports?: unknown }
      return (
        typeof pkg.exports === 'object' &&
        pkg.exports !== null &&
        './provider' in (pkg.exports as Record<string, unknown>)
      )
    } catch {
      return false
    }
  })
}

/** `@strutvane/social-login` → `socialLogin` (the import name the hint suggests). */
function importName(name: string): string {
  return name
    .slice('@strutvane/'.length)
    .split(/[^a-z0-9]+/)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')
}

/**
 * The doctor's application checks, in place of the v1 registry and `strutvane.config.ts` checks:
 * the app boots (config, env, providers, every route), `.strutvane/resources.json` exists, and
 * every installed add-on that ships a provider is registered in `bootstrap/providers.ts` (an
 * add-on installed but not registered serves nothing: that is how sign-in went missing in the
 * demo acceptance run, AUTH-2).
 *
 * @example
 * await appDoctorChecks('/srv/northwind', ['@strutvane/auth'], DEFAULT_APP_DEPS)
 */
export async function appDoctorChecks(
  root: string,
  dependencies: readonly string[],
  deps: AppCommandDeps,
): Promise<AppDoctorCheck[]> {
  const checks: AppDoctorCheck[] = []
  let app: Application | undefined
  try {
    app = await deps.load(root)
    await app.boot()
    checks.push({
      id: 'app-boots',
      status: 'ok',
      message: `The app boots (${app.routes.length} routes checked)`,
    })
  } catch (error) {
    checks.push(
      isBootError(error)
        ? { id: 'app-boots', status: 'fail', message: error.message, hint: error.hint }
        : {
            id: 'app-boots',
            status: 'fail',
            message: `The app does not boot: ${error instanceof Error ? error.message : String(error)}`,
            hint: 'Run node strut route:list to see the whole error.',
          },
    )
  } finally {
    if (app?.state === 'booted') await app.shutdown()
  }
  checks.push(
    readAppMetadata(root) === undefined
      ? {
          id: 'resources',
          status: 'warn',
          message: '.strutvane/resources.json is missing',
          hint: 'Run node strut migrate (or node strut sync, without a database) to generate it.',
        }
      : { id: 'resources', status: 'ok', message: '.strutvane/resources.json is present' },
  )
  const providersFile = join(root, 'bootstrap', 'providers.ts')
  const providers = existsSync(providersFile) ? readFileSync(providersFile, 'utf8') : ''
  for (const name of providerPackages(root, dependencies)) {
    const specifier = `${name}/provider`
    if (providers.includes(`'${specifier}'`) || providers.includes(`"${specifier}"`)) continue
    const local = importName(name)
    checks.push({
      id: 'providers',
      status: 'warn',
      message: `${name} is installed but its provider is not registered, so it serves nothing`,
      hint: `In bootstrap/providers.ts: import ${local} from '${specifier}', then add ${local} to the list.`,
    })
  }
  return checks
}
