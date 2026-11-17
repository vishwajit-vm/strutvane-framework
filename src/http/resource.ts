/**
 * Resource configuration: how a model is exposed over HTTP. A bare model gets every default
 * (all six routes, no includes, no hooks); `defineResource` customises it without ejecting.
 *
 * @module
 */
import type { Actor } from '../contracts/index.ts'
import type { Application } from '../core/index.ts'
import type { DataRecord, Repository, Scope } from '../data/repository.ts'
import type { Database } from '../database/types.ts'
import type { AnyModel, ModelDefinition } from '../model/define-model.ts'

/** The standard actions and their permission suffixes. */
export type ResourceAction = 'list' | 'show' | 'create' | 'update' | 'delete' | 'restore'

/** Permission suffix per action (`invoice.viewAny`, `invoice.view`, …). */
export const ACTION_PERMISSIONS: Readonly<Record<ResourceAction, string>> = Object.freeze({
  list: 'viewAny',
  show: 'view',
  create: 'create',
  update: 'update',
  delete: 'delete',
  restore: 'restore',
})

/** What hooks receive about the current request. */
export interface ResourceContext {
  readonly model: ModelDefinition
  readonly actor: Actor | null
  readonly tenantId: string | undefined
  readonly requestId: string
  readonly locale: string
  /** This resource's repository. */
  readonly repository: Repository
  /**
   * Another model's repository (e.g. recompute an invoice's totals after a line changes). It
   * applies only the scope you pass: use {@link ResourceContext.scope}.
   */
  repositoryFor(model: AnyModel | ModelDefinition | string): Repository
  /** `{ tenantId }` of the request (tenant-scoped models refuse to run without it). */
  readonly scope: Scope
  /** The booted application (storage, logger, config: `app.make(Token)`). */
  readonly app: Application
}

/** A write the API made: what happened, to which row, and the row before an update. */
export interface WriteChange {
  readonly action: 'create' | 'update' | 'delete' | 'restore'
  /** The row as written (for a delete: the row as it was). */
  readonly record: DataRecord
  /** The row before the change (updates only). */
  readonly previous?: DataRecord
}

/**
 * What an `onWrite` hook receives: the request context, bound to the write's transaction.
 * `repository` and `repositoryFor` write through the same transaction, so their changes commit or
 * roll back with the write.
 */
export interface WriteContext extends ResourceContext {
  /** The transaction the write runs in. */
  readonly db: Database
}

/** A hook may return a replacement value, or nothing to keep the original. */
type MaybeReplace<T> = T | undefined | Promise<T | undefined>

/**
 * Per-resource lifecycle hooks (docs/06 §5.3). Throw a Strutvane error to stop the request.
 *
 * Writes have two stages after the `before*` hooks:
 * 1. {@link ResourceHooks.onWrite} runs **inside** the write's transaction. Throwing rolls the
 *    write back and answers with that error. Use it for work that must happen with the write.
 * 2. After the commit, `after*`, {@link ResourceHooks.afterCommit} and the domain event run. The
 *    write has happened, so a failure there is **logged and never changes the response** (a 500
 *    for a committed write would make the client retry and write twice). Use it for side effects
 *    that may fail on their own: mail, webhooks, cache warming.
 */
export interface ResourceHooks {
  beforeList?(ctx: ResourceContext): void | Promise<void>
  beforeShow?(id: string, ctx: ResourceContext): void | Promise<void>
  beforeCreate?(
    input: Record<string, unknown>,
    ctx: ResourceContext,
  ): MaybeReplace<Record<string, unknown>>
  /**
   * Inside the transaction, for create, update, delete and restore. Throwing rolls back.
   *
   * @example
   * onWrite: async (change, ctx) => {
   *   await ctx.repositoryFor('Ledger').create({ note: `${change.action} ${change.record.id}` }, ctx.scope)
   * }
   */
  onWrite?(change: WriteChange, ctx: WriteContext): void | Promise<void>
  /**
   * After the commit, for every write action. A failure is logged, never sent to the client.
   *
   * @example
   * afterCommit: async (change) => { await webhooks.send('deal.changed', change.record.id) }
   */
  afterCommit?(change: WriteChange, ctx: ResourceContext): void | Promise<void>
  /** After the commit (a failure is logged, never sent to the client). */
  afterCreate?(record: DataRecord, ctx: ResourceContext): void | Promise<void>
  beforeUpdate?(
    patch: Record<string, unknown>,
    existing: DataRecord,
    ctx: ResourceContext,
  ): MaybeReplace<Record<string, unknown>>
  /** After the commit (a failure is logged, never sent to the client). */
  afterUpdate?(record: DataRecord, previous: DataRecord, ctx: ResourceContext): void | Promise<void>
  beforeDelete?(record: DataRecord, ctx: ResourceContext): void | Promise<void>
  /** After the commit (a failure is logged, never sent to the client). */
  afterDelete?(record: DataRecord, ctx: ResourceContext): void | Promise<void>
  beforeRestore?(record: DataRecord, ctx: ResourceContext): void | Promise<void>
  /** After the commit (a failure is logged, never sent to the client). */
  afterRestore?(record: DataRecord, ctx: ResourceContext): void | Promise<void>
  /** Last chance to shape each record in a response (after hidden fields are removed). */
  transformResponse?(
    record: Record<string, unknown>,
    ctx: ResourceContext,
  ): MaybeReplace<Record<string, unknown>>
}

/** How a model is exposed. */
export interface ResourceConfig {
  readonly model: AnyModel | ModelDefinition
  /** Relations (belongsTo field keys and hasMany relation keys) clients may `include`. */
  readonly includes?: readonly string[]
  readonly hooks?: ResourceHooks
  /** Turn individual routes off (all on by default; `restore` only exists with soft deletes). */
  readonly routes?: Partial<Record<ResourceAction, boolean>>
  /** Page size limits for this resource (never above the global maximum of 100). */
  readonly pageSize?: { readonly default?: number; readonly max?: number }
  /**
   * Allow clients to ask for a total count (`page[total]=true`, `"total": true`). Default
   * `false`: a count scans every matching row, so on a large table each request becomes a full
   * scan a client can repeat at will. Turn it on for resources whose tables stay small or whose
   * filters are indexed.
   */
  readonly allowTotal?: boolean
  /** UI hints passed through to the manifest. */
  readonly ui?: {
    readonly icon?: string
    readonly group?: string
    readonly listColumns?: readonly string[]
  }
}

/**
 * Define a resource. Two equivalent forms:
 * - `defineResource(Invoice, { includes: ['customer'] })`: the form `node strut make:resource`
 *   generates and the registry compiler reads (`app/resources/*.resource.ts`);
 * - `defineResource({ model: Invoice, includes: ['customer'] })`.
 */
export function defineResource(
  model: AnyModel | ModelDefinition,
  config?: Omit<ResourceConfig, 'model'>,
): ResourceConfig
export function defineResource(config: ResourceConfig): ResourceConfig
export function defineResource(
  first: ResourceConfig | AnyModel | ModelDefinition,
  config: Omit<ResourceConfig, 'model'> = {},
): ResourceConfig {
  if ('model' in first) return first
  return { ...config, model: first }
}

/** A resource with its definition resolved. */
export interface ResolvedResource extends ResourceConfig {
  readonly definition: ModelDefinition
}

/** Normalise models and resource configs into resolved resources; validates includes. */
export function resolveResources(
  items: readonly (ResourceConfig | AnyModel)[],
): ResolvedResource[] {
  return items.map((item) => {
    const config: ResourceConfig = 'model' in item ? item : { model: item }
    const definition = 'definition' in config.model ? config.model.definition : config.model
    for (const inc of config.includes ?? []) {
      const f = definition.fields[inc]
      if (!(f?.kind === 'belongsTo' || definition.relations[inc])) {
        throw new TypeError(
          `${definition.name}: include "${inc}" is not a belongsTo field or hasMany relation`,
        )
      }
      if (f?.hidden) {
        throw new TypeError(`${definition.name}: include "${inc}" is a hidden field`)
      }
    }
    return { ...config, definition }
  })
}

/** Whether a route is enabled for a resource. */
export function routeEnabled(resource: ResolvedResource, action: ResourceAction): boolean {
  if (action === 'restore' && !resource.definition.options.softDeletes) return false
  return resource.routes?.[action] ?? true
}
