/**
 * `node strut migrate`, step 4 of the blueprint (§2.4): every table with a model gets a CRUD API,
 * registered through the machine-owned `routes/resources.gen.ts` that `routes/api.ts` imports
 * (acceptance FW-4: migrate generated no API and no screens).
 *
 * What is written, and who owns it:
 *
 * | File | Owner | When |
 * |---|---|---|
 * | `routes/resources.gen.ts` | the framework | rewritten whenever its content would change (never hand-edit it) |
 * | `routes/api.ts` | you | linked **once**, when `resources.gen.ts` is first created: one import and `...resources` in its `defineRoutes([…])`. If the file has another shape, nothing is changed and the two lines to add are printed. Removing them later is respected: they are never added again |
 *
 * Per model the generated file uses the app's own controller when
 * `app/http/controllers/<model>.controller.ts` exports `<Model>Controller` (L2/L3: replace it with
 * `make:controller CustomerController --resource`), and `resourceController(Customer)` otherwise.
 * A model opts out with `static readonly api = false`. Internal tables (sessions, users, …) and
 * tables without a model never get a resource.
 *
 * The UI needs no file of its own: `@strutvane/ui` builds its screens and sidebar from the
 * manifest the API publishes, which lists these resources (from `.strutvane/resources.json`).
 * The `registered: API … · UI … · menu "…"` line says where each new resource appears.
 *
 * Model files are read as text, never run: generation can't execute app code.
 *
 * @module
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { humanize, singularize } from '../core/inflection.ts'
import type { SchemaState, TableState } from '../schema/columns.ts'
import type { AppModels } from '../schema/generate/model-options.ts'
import { isInternalTable } from '../schema/internal-tables.ts'
import { kebabCase, singular } from '../support/str.ts'

/** The machine-owned routes file, relative to the project root. */
export const RESOURCE_ROUTES_FILE = 'routes/resources.gen.ts'
const API_ROUTES_FILE = 'routes/api.ts'
const RESOURCE_MARKER = '// resource:'

/** One resource the generated file registers. */
export interface GeneratedResource {
  readonly table: string
  readonly model: string
  /** The URL segment under the API prefix (`order-items`). */
  readonly route: string
  /** The sidebar label (`Order items`). */
  readonly menu: string
  /** `true` when the app's own controller is used. */
  readonly ownController: boolean
}

/** What {@link generateResourceRoutes} did. */
export interface ResourceGeneration {
  readonly resources: readonly GeneratedResource[]
  /** Resources that were not in the previous file: the ones to announce. */
  readonly added: readonly GeneratedResource[]
  /** Files written (relative, forward slashes). */
  readonly written: readonly string[]
  /** `routes/api.ts` could not be linked automatically: the lines to add by hand. */
  readonly manualLink?: readonly string[]
  /** Models that could not be used (no export, …), with the reason. */
  readonly warnings: readonly string[]
}

/**
 * Write `routes/resources.gen.ts` for the app's models (and link it into `routes/api.ts` the first
 * time). Idempotent: running it twice changes nothing.
 *
 * @example
 * const result = generateResourceRoutes(root, replay.state, readAppModels(root))
 * for (const resource of result.added) out.success(registeredLine(resource, '/api'))
 */
export function generateResourceRoutes(
  root: string,
  state: SchemaState,
  models: AppModels,
): ResourceGeneration {
  const warnings: string[] = []
  const resources: (GeneratedResource & {
    readonly importLine: string
    readonly binding: string
  })[] = []
  for (const table of state.tables) {
    const options = models.tables.get(table.name)
    if (options === undefined || !servable(table)) continue
    const modelFile = join(root, ...options.file.split('/'))
    const source = existsSync(modelFile) ? readFileSync(modelFile, 'utf8') : ''
    if (/static\s+(?:readonly\s+)?api\s*=\s*false/.test(source)) continue
    const exported = exportOf(source, options.model)
    if (exported === undefined) {
      warnings.push(
        `${options.file}: ${options.model} is not exported, so it gets no API. Write \`export class ${options.model} extends Model(…)\`.`,
      )
      continue
    }
    const modelImport = importPath(options.file)
    const controller = ownController(root, options.model)
    const route = table.name.replace(/_/g, '-')
    resources.push({
      table: table.name,
      model: options.model,
      route,
      menu: humanize(table.name),
      ownController: controller !== undefined,
      importLine:
        controller ??
        (exported === 'default'
          ? `import ${options.model} from '${modelImport}'`
          : `import { ${options.model} } from '${modelImport}'`),
      binding: singularize(table.name),
    })
  }
  const file = join(root, ...RESOURCE_ROUTES_FILE.split('/'))
  const existed = existsSync(file)
  const previous = existed ? readFileSync(file, 'utf8') : ''
  const before = new Set(
    previous
      .split('\n')
      .filter((line) => line.startsWith(RESOURCE_MARKER))
      .map((line) => line.slice(RESOURCE_MARKER.length).trim()),
  )
  const content = renderRoutesFile(resources, state)
  const written: string[] = []
  if (content !== previous) {
    writeFileSync(file, content)
    written.push(RESOURCE_ROUTES_FILE)
  }
  let manualLink: readonly string[] | undefined
  // routes/api.ts is the developer's: linked once, when the generated file first appears.
  if (!existed) {
    const linked = linkApiRoutes(root)
    if (linked === 'linked') written.push(API_ROUTES_FILE)
    else if (linked === 'manual') manualLink = MANUAL_LINES
  }
  const plain = resources.map(({ importLine: _import, binding: _binding, ...rest }) => rest)
  return {
    resources: plain,
    added: plain.filter((resource) => !before.has(resource.table)),
    written,
    ...(manualLink === undefined ? {} : { manualLink }),
    warnings,
  }
}

/**
 * The DX contract's announcement for a new resource.
 *
 * @example
 * registeredLine(resource, '/api') // 'registered: API /api/customers · UI /customers · menu "Customers"'
 */
export function registeredLine(resource: GeneratedResource, apiPrefix: string): string {
  const prefix = `/${apiPrefix.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '')
  return `registered: API ${prefix}/${resource.route} · UI /${resource.route} · menu "${resource.menu}"`
}

const MANUAL_LINES: readonly string[] = [
  "import resources from './resources.gen.ts'",
  'export default defineRoutes([...resources, /* your routes */])',
]

/** A table that may get an auto API: has a model-style key and isn't internal. */
function servable(table: TableState): boolean {
  if (table.internal === true || isInternalTable(table.name)) return false
  return table.columns.some((column) => column.name === 'id')
}

/** How the model file exports the class: `'named'`, `'default'`, or `undefined` (not exported). */
function exportOf(source: string, name: string): 'named' | 'default' | undefined {
  if (new RegExp(`export\\s+default\\s+class\\s+${name}\\b`).test(source)) return 'default'
  if (new RegExp(`export\\s+(?:abstract\\s+)?class\\s+${name}\\b`).test(source)) return 'named'
  if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source)) return 'named'
  return undefined
}

/** `app/models/customer.ts` → `'../app/models/customer.ts'` (relative to `routes/`). */
function importPath(file: string): string {
  return `../${file.replace(/^\.?\//, '')}`
}

/** The import line of the app's own `<Model>Controller`, when it has one. */
function ownController(root: string, model: string): string | undefined {
  const relativeFile = `app/http/controllers/${kebabCase(model)}.controller.ts`
  const file = join(root, ...relativeFile.split('/'))
  if (!existsSync(file)) return undefined
  const name = `${model}Controller`
  const exported = exportOf(readFileSync(file, 'utf8'), name)
  if (exported === undefined) return undefined
  return exported === 'default'
    ? `import ${name} from '../${relativeFile}'`
    : `import { ${name} } from '../${relativeFile}'`
}

function renderRoutesFile(
  resources: readonly (GeneratedResource & {
    readonly importLine: string
    readonly binding: string
  })[],
  state: SchemaState,
): string {
  const softDeletes = (table: string): boolean =>
    state.tables
      .find((candidate) => candidate.name === table)
      ?.columns.some((column) => column.name === 'deleted_at') === true
  const needsFactory = resources.some((resource) => !resource.ownController)
  const lines: string[] = [
    '// Generated by `node strut migrate` from your models: do not edit, it is rewritten on every',
    '// migrate. Each model gets the CRUD API of a ResourceController (deny by default: without',
    '// app/policies/<model>.policy.ts only admins get in).',
    '//',
    '// - Your own controller: create app/http/controllers/<model>.controller.ts exporting',
    '//   <Model>Controller (node strut make:controller CustomerController --resource).',
    '// - No API for a model: add `static readonly api = false` to its class.',
    `import { ${needsFactory ? 'resourceController, ' : ''}Route } from '@strutvane/framework'`,
    ...resources.map((resource) => resource.importLine),
    '',
  ]
  for (const resource of resources)
    if (!resource.ownController)
      lines.push(`const ${resource.model}Controller = resourceController(${resource.model})`)
  if (needsFactory) lines.push('')
  lines.push('export default [')
  for (const resource of resources) {
    const controller = `${resource.model}Controller`
    const parameter = resource.binding
    // The default parameter is the singular of the path; spell it out when the path has a dash.
    const options = singular(resource.route) === parameter ? '' : `, { parameter: '${parameter}' }`
    lines.push(`  ${RESOURCE_MARKER} ${resource.table}`)
    lines.push(
      `  Route.apiResource('${resource.route}', ${controller}${options}).middleware('auth'),`,
    )
    if (softDeletes(resource.table))
      lines.push(
        `  Route.post('/${resource.route}/{${parameter}}/restore', [${controller}, 'restore'])`,
        `    .withTrashed()`,
        `    .middleware('auth')`,
        `    .name('${resource.route}.restore'),`,
      )
  }
  lines.push('] as const', '')
  return lines.join('\n')
}

/**
 * Add the generated routes to `routes/api.ts`: an import, and `...resources` as the first entry of
 * its `defineRoutes([` array. Only that exact, unambiguous shape is changed.
 */
function linkApiRoutes(root: string): 'linked' | 'already' | 'manual' {
  const file = join(root, ...API_ROUTES_FILE.split('/'))
  if (!existsSync(file)) return 'manual'
  const source = readFileSync(file, 'utf8')
  if (source.includes('resources.gen')) return 'already'
  const opening = 'export default defineRoutes(['
  if (source.split(opening).length !== 2) return 'manual'
  const lines = source.split('\n')
  let lastImport = -1
  for (const [index, line] of lines.entries())
    if (/^import\s/.test(line) || /^}\s*from\s/.test(line)) lastImport = index
  if (lastImport === -1) return 'manual'
  lines.splice(lastImport + 1, 0, "import resources from './resources.gen.ts'")
  const linked = lines
    .join('\n')
    .replace(
      opening,
      `${opening}\n  // The CRUD API of your models (routes/resources.gen.ts, rewritten by node strut migrate).\n  ...resources,\n  `,
    )
  writeFileSync(file, linked)
  return 'linked'
}
