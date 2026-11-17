/**
 * `sv routes`, `sv models` and `sv permissions`: read the registry (docs/09 §5).
 *
 * The registry is compiled in memory from source (never by importing the app), so these commands
 * work without a database, without env variables and even while the generated file is stale.
 *
 * Automatic CRUD routes follow the framework's documented convention:
 * `GET/POST /api/v1/<plural>` and `GET/PATCH/DELETE /api/v1/<plural>/:id`, plus restore and force
 * delete for soft-deleting models and one `POST …/:id/actions/<action>` per resource action.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { type AnyCommand, type CommandContext, defineCommand } from '../framework/command.ts'
import { CliError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { names } from '../make/names.ts'
import { analyzeFile, type ResourceEntry } from '../registry/analyze.ts'
import { RegistryCompiler } from '../registry/compiler.ts'
import { discover } from '../registry/discover.ts'
import { formatDiagnostic } from '../registry/errors.ts'
import type { Registry } from '../registry/registry.ts'

/** The default API prefix for automatic routes. */
export const API_PREFIX = '/api/v1'

/** One row of `sv routes`. */
export interface RouteRow {
  readonly method: string
  readonly path: string
  readonly name: string
  readonly permission: string | null
  /** `auto` (CRUD from a model), `resource` (a resource action) or `custom` (app/http/routes). */
  readonly source: 'auto' | 'resource' | 'custom'
  readonly model: string | null
  readonly file: string
}

/** Compile the registry, failing with diagnostics if the app has errors. */
function compile(ctx: CommandContext): { registry: Registry; root: string } {
  const root = ctx.requireProject().root
  const result = new RegistryCompiler(root).compile()
  for (const d of result.diagnostics)
    if (d.severity === 'warning') ctx.out.warn(formatDiagnostic(d))
  if (result.registry === undefined) {
    const errors = result.diagnostics.filter((d) => d.severity === 'error')
    throw new CliError('registry_errors', {
      exitCode: EXIT.VALIDATION,
      params: { count: errors.length },
      issues: errors.map((d) => ({ path: [d.file], code: d.code, message: formatDiagnostic(d) })),
    })
  }
  return { registry: result.registry, root }
}

/** Resource actions per model name (read from the resource files). */
function resourceActions(root: string, registry: Registry): Map<string, ResourceEntry['actions']> {
  const byFile = new Map(registry.resources.map((r) => [r.file, r.model]))
  const actions = new Map<string, ResourceEntry['actions']>()
  for (const file of discover(root).files) {
    const model = byFile.get(file.relPath)
    if (model === undefined) continue
    const entry = analyzeFile(file, readFileSync(file.absPath, 'utf8')).entries.find(
      (e): e is ResourceEntry => e.kind === 'resource',
    )
    if (entry !== undefined) actions.set(model, entry.actions)
  }
  return actions
}

/** Every route: automatic CRUD, resource actions and custom routes. Sorted by path, then method. */
export function routeTable(root: string, registry: Registry): RouteRow[] {
  const rows: RouteRow[] = []
  const actions = resourceActions(root, registry)
  for (const model of registry.models) {
    if (!model.api) continue
    const n = names(model.name)
    const base = `${API_PREFIX}/${n.kebabPlural}`
    const auto = (method: string, path: string, action: string, verb: string): RouteRow => ({
      method,
      path,
      name: `${n.kebabPlural}.${verb}`,
      permission: `${n.camel}.${action}`,
      source: 'auto',
      model: model.name,
      file: model.file,
    })
    rows.push(
      auto('GET', base, 'viewAny', 'index'),
      auto('POST', base, 'create', 'store'),
      auto('GET', `${base}/:id`, 'view', 'show'),
      auto('PATCH', `${base}/:id`, 'update', 'update'),
      auto('DELETE', `${base}/:id`, 'delete', 'destroy'),
    )
    if (model.softDeletes) {
      rows.push(
        auto('POST', `${base}/:id/restore`, 'restore', 'restore'),
        auto('DELETE', `${base}/:id/force`, 'forceDelete', 'forceDelete'),
      )
    }
    const resource = registry.resources.find((r) => r.model === model.name)
    for (const action of actions.get(model.name) ?? []) {
      rows.push({
        method: 'POST',
        path: `${base}/:id/actions/${action.name}`,
        name: `${n.kebabPlural}.${action.name}`,
        permission: action.permission ?? `${n.camel}.${action.name}`,
        source: 'resource',
        model: model.name,
        file: resource?.file ?? model.file,
      })
    }
  }
  for (const route of registry.routes) {
    rows.push({
      method: route.method,
      path: route.path,
      name: route.name,
      permission: route.permission ?? null,
      source: 'custom',
      model: null,
      file: route.file,
    })
  }
  return rows.sort((a, b) =>
    a.path === b.path
      ? a.method < b.method
        ? -1
        : a.method > b.method
          ? 1
          : 0
      : a.path < b.path
        ? -1
        : 1,
  )
}

export const routesCommand: AnyCommand = defineCommand({
  name: 'routes',
  description: 'List every route: method, path, name, permission and source',
  flags: {
    method: { type: 'string', valueName: '<METHOD>', description: 'Only this HTTP method' },
    path: { type: 'string', valueName: '<text>', description: 'Only paths containing this text' },
    model: { type: 'string', valueName: '<Model>', description: "Only this model's routes" },
  },
  examples: ['sv routes', 'sv routes --model Invoice --method POST', 'sv routes --json'],
  run(ctx) {
    const { registry, root } = compile(ctx)
    const method = ctx.flags.method?.toUpperCase()
    const rows = routeTable(root, registry).filter(
      (r) =>
        (method === undefined || r.method === method) &&
        (ctx.flags.path === undefined || r.path.includes(ctx.flags.path)) &&
        (ctx.flags.model === undefined || r.model === ctx.flags.model),
    )
    ctx.out.table(
      ['Method', 'Path', 'Name', 'Permission', 'Source'],
      rows.map((r) => [
        r.method,
        r.path,
        r.name,
        r.permission ?? ctx.out.style.dim('(public)'),
        r.source,
      ]),
    )
    return { data: { routes: rows } }
  },
})

export const modelsCommand: AnyCommand = defineCommand({
  name: 'models',
  description: 'List registered models with their fields, relations and options',
  flags: {
    model: { type: 'string', valueName: '<Model>', description: 'Only this model' },
  },
  examples: ['sv models', 'sv models --model Invoice --json'],
  run(ctx) {
    const { registry } = compile(ctx)
    const models = registry.models
      .filter((m) => ctx.flags.model === undefined || m.name === ctx.flags.model)
      .map((m) => ({
        name: m.name,
        file: m.file,
        fields: m.fieldDetails.map((f) => ({
          name: f.name,
          type: f.type ?? null,
          target: f.target ?? null,
        })),
        softDeletes: m.softDeletes,
        tenant: m.tenant,
        api: m.api,
        resource: registry.resources.find((r) => r.model === m.name)?.file ?? null,
        policy: registry.policies.find((p) => p.resource === names(m.name).camel)?.file ?? null,
      }))
    const { out } = ctx
    models.forEach((m, i) => {
      if (i > 0) out.line()
      const flags = [
        m.tenant ? 'tenant' : '',
        m.softDeletes ? 'soft deletes' : '',
        m.api ? '' : 'no api',
      ]
        .filter((f) => f !== '')
        .join(', ')
      out.line(
        `${out.style.bold(m.name)} ${out.style.dim(m.file)}${flags === '' ? '' : ` (${flags})`}`,
      )
      out.table(
        ['  Field', 'Type', 'Related'],
        m.fields.map((f) => [`  ${f.name}`, f.type ?? '?', f.target ?? '']),
      )
    })
    return { data: { models } }
  },
})

export const permissionsCommand: AnyCommand = defineCommand({
  name: 'permissions',
  description: 'List every permission the app uses (CRUD, resource actions, routes)',
  flags: {
    model: { type: 'string', valueName: '<Model>', description: "Only this model's permissions" },
  },
  examples: ['sv permissions', 'sv permissions --json'],
  run(ctx) {
    const { registry } = compile(ctx)
    const prefix = ctx.flags.model === undefined ? undefined : `${names(ctx.flags.model).camel}.`
    const permissions = registry.permissions.filter(
      (p) => prefix === undefined || p.startsWith(prefix),
    )
    for (const p of permissions) ctx.out.line(p)
    return { data: { permissions } }
  },
})
