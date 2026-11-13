/**
 * Registry building: combine per-file analyses into one registry and apply the rules that need
 * the whole project (duplicates, references between files, derived permissions).
 *
 * Input analyses arrive sorted by file path, so "first" and "duplicate" are stable across runs.
 */
import type { Entry, FileAnalysis, ModelEntry, NamedEntry, PageEntry, Position } from './analyze.ts'
import type { Diagnostic, DiagnosticCode } from './errors.ts'
import { isValidPermission, resourceKey } from './names.ts'
import { compareCodeUnits } from './paths.ts'

export interface ResourceInfo {
  readonly model: string
  readonly file: string
}

export interface PolicyInfo {
  readonly resource: string
  readonly file: string
}

export interface RouteInfo {
  readonly name: string
  readonly method: string
  readonly path: string
  readonly permission: string | undefined
  readonly file: string
}

export interface Registry {
  readonly models: readonly ModelEntry[]
  readonly resources: readonly ResourceInfo[]
  readonly policies: readonly PolicyInfo[]
  readonly routes: readonly RouteInfo[]
  readonly jobs: readonly NamedEntry[]
  readonly listeners: readonly NamedEntry[]
  readonly commands: readonly NamedEntry[]
  readonly pages: readonly PageEntry[]
  /** Every permission string the app uses, sorted and unique. */
  readonly permissions: readonly string[]
}

/** CRUD permissions every model gets (restore/forceDelete only with soft deletes). */
const BASE_ACTIONS = ['viewAny', 'view', 'create', 'update', 'delete', 'export'] as const
const SOFT_DELETE_ACTIONS = ['restore', 'forceDelete'] as const

export function buildRegistry(analyses: readonly FileAnalysis[]): {
  registry: Registry
  diagnostics: Diagnostic[]
} {
  const diagnostics: Diagnostic[] = []
  const report = (
    code: DiagnosticCode,
    file: string,
    at: Position,
    message: string,
    hint?: string,
  ): void => {
    const base = {
      code,
      severity: 'error' as const,
      message,
      file,
      line: at.line,
      column: at.column,
    }
    diagnostics.push(hint === undefined ? base : { ...base, hint })
  }

  const entries: Entry[] = analyses.flatMap((a) => a.entries)
  const ofKind = <K extends Exclude<Entry['kind'], NamedEntry['kind']>>(
    kind: K,
  ): Extract<Entry, { kind: K }>[] =>
    entries.filter((e): e is Extract<Entry, { kind: K }> => e.kind === kind)
  // NamedEntry covers three kinds with one shape, so Extract<> would collapse to never; narrow directly.
  const named = (kind: NamedEntry['kind']): NamedEntry[] =>
    entries.filter((e): e is NamedEntry => e.kind === kind)

  // ---- models ----
  const modelsByName = new Map<string, ModelEntry>()
  const modelsByFile = new Map<string, ModelEntry>()
  for (const model of ofKind('model')) {
    const first = modelsByName.get(model.name)
    if (first !== undefined) {
      report(
        'DUPLICATE_MODEL',
        model.file,
        model.at,
        `Model "${model.name}" is already defined in ${first.file}.`,
        'Model names must be unique. Rename or remove one of them.',
      )
      continue
    }
    modelsByName.set(model.name, model)
    modelsByFile.set(model.file, model)
  }
  const modelsByKey = new Map([...modelsByName.values()].map((m) => [resourceKey(m.name), m]))

  const permissions = new Set<string>()
  const addPermission = (permission: string, file: string, at: Position): void => {
    if (!isValidPermission(permission)) {
      report(
        'INVALID_PERMISSION',
        file,
        at,
        `"${permission}" is not a valid permission.`,
        'Use "resource.action" in lower camel case, e.g. "invoice.approve".',
      )
      return
    }
    permissions.add(permission)
  }
  for (const model of modelsByName.values()) {
    const key = resourceKey(model.name)
    for (const action of BASE_ACTIONS) permissions.add(`${key}.${action}`)
    if (model.softDeletes)
      for (const action of SOFT_DELETE_ACTIONS) permissions.add(`${key}.${action}`)
  }

  // ---- resources ----
  const resources: ResourceInfo[] = []
  const resourceFor = new Map<string, string>()
  for (const resource of ofKind('resource')) {
    const model =
      'file' in resource.modelRef
        ? modelsByFile.get(resource.modelRef.file)
        : modelsByName.get(resource.modelRef.name)
    if (model === undefined) {
      const ref = 'file' in resource.modelRef ? resource.modelRef.file : resource.modelRef.name
      report(
        'UNKNOWN_MODEL',
        resource.file,
        resource.at,
        `This resource refers to "${ref}", which is not a model.`,
        'Import a file from app/models/ that default-exports defineModel(…).',
      )
      continue
    }
    const existing = resourceFor.get(model.name)
    if (existing !== undefined) {
      report(
        'DUPLICATE_RESOURCE',
        resource.file,
        resource.at,
        `Model "${model.name}" already has a resource in ${existing}.`,
        'Merge the two resource files.',
      )
      continue
    }
    resourceFor.set(model.name, resource.file)
    resources.push({ model: model.name, file: resource.file })
    const key = resourceKey(model.name)
    for (const action of resource.actions)
      addPermission(action.permission ?? `${key}.${action.name}`, resource.file, action.at)
  }

  // ---- policies ----
  const policies: PolicyInfo[] = []
  const policyFor = new Map<string, string>()
  for (const policy of ofKind('policy')) {
    if (!modelsByKey.has(policy.resource)) {
      report(
        'UNKNOWN_MODEL',
        policy.file,
        policy.at,
        `Policy for "${policy.resource}", but no model has that resource key.`,
        `Resource keys are the model name in lower camel case, e.g. Invoice → "invoice".`,
      )
      continue
    }
    const existing = policyFor.get(policy.resource)
    if (existing !== undefined) {
      report(
        'DUPLICATE_POLICY',
        policy.file,
        policy.at,
        `"${policy.resource}" already has a policy in ${existing}.`,
        'Keep one policy file per resource.',
      )
      continue
    }
    policyFor.set(policy.resource, policy.file)
    policies.push({ resource: policy.resource, file: policy.file })
  }

  // ---- routes ----
  const routes: RouteInfo[] = []
  const routeKeys = new Map<string, string>()
  const routeNames = new Map<string, string>()
  for (const route of ofKind('route')) {
    const key = `${route.method} ${route.path}`
    const name = route.name ?? key
    const existingKey = routeKeys.get(key)
    if (existingKey !== undefined) {
      report(
        'DUPLICATE_ROUTE',
        route.file,
        route.at,
        `${key} is already declared in ${existingKey}.`,
      )
      continue
    }
    const existingName = routeNames.get(name)
    if (existingName !== undefined) {
      report(
        'DUPLICATE_ROUTE_NAME',
        route.file,
        route.at,
        `Route name "${name}" is already used in ${existingName}.`,
      )
      continue
    }
    routeKeys.set(key, route.file)
    routeNames.set(name, route.file)
    if (route.permission !== undefined) addPermission(route.permission, route.file, route.at)
    routes.push({
      name,
      method: route.method,
      path: route.path,
      permission: route.permission,
      file: route.file,
    })
  }

  // ---- jobs / commands (unique names), listeners (many per event) ----
  const unique = (list: NamedEntry[], code: DiagnosticCode, label: string): NamedEntry[] => {
    const seen = new Map<string, string>()
    const kept: NamedEntry[] = []
    for (const item of list) {
      const first = seen.get(item.name)
      if (first !== undefined) {
        report(code, item.file, item.at, `${label} "${item.name}" is already defined in ${first}.`)
        continue
      }
      seen.set(item.name, item.file)
      kept.push(item)
    }
    return kept
  }
  const jobs = unique(named('job'), 'DUPLICATE_JOB', 'Job')
  const commands = unique(named('command'), 'DUPLICATE_COMMAND', 'Command')
  const listeners = named('listener')

  // ---- pages ----
  const pages: PageEntry[] = []
  const pageRoutes = new Map<string, string>()
  for (const page of ofKind('page')) {
    const first = pageRoutes.get(page.route)
    if (first !== undefined) {
      report(
        'DUPLICATE_PAGE_ROUTE',
        page.file,
        page.at,
        `URL "${page.route}" is already served by ${first}.`,
        'e.g. invoices.tsx and invoices/index.tsx both map to /invoices. Keep one.',
      )
      continue
    }
    pageRoutes.set(page.route, page.file)
    pages.push(page)
  }

  const by =
    <T>(key: (t: T) => string) =>
    (a: T, b: T): number =>
      compareCodeUnits(key(a), key(b))
  const registry: Registry = {
    models: [...modelsByName.values()].sort(by((m) => m.name)),
    resources: resources.sort(by((r) => r.model)),
    policies: policies.sort(by((p) => p.resource)),
    routes: routes.sort(by((r) => `${r.path}\u0000${r.method}`)),
    jobs: jobs.sort(by((j) => j.name)),
    listeners: listeners.sort(by((l) => `${l.name}\u0000${l.file}`)),
    commands: commands.sort(by((c) => c.name)),
    pages: pages.sort(by((p) => p.route)),
    permissions: [...permissions].sort(compareCodeUnits),
  }
  return { registry, diagnostics }
}
