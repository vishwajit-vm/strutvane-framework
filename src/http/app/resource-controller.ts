/**
 * Controllers: a plain `Controller` base (Laravel's empty `App\Http\Controllers\Controller`), and
 * `ResourceController`, which gives a model the five API actions with:
 *
 * - **index:** the model's own list query (search, sort, filters, pagination, every name checked
 *   against its allow-lists), behind the policy's `viewAny`, with the policy's **list scope**
 *   (`viewScope`, the SQL form of `view`) and `indexConstraints` ANDed in, and every row checked
 *   against `view` once more: a list never shows a row `view` refuses;
 * - **show / update / destroy:** the route-bound record, behind `view` / `update` / `delete`;
 *   a record the user may not `view` answers exactly like a missing one (404, `visible()`);
 * - **store / update:** form-request validation (yours, or derived from the metadata), unknown
 *   fields refused, mass assignment only through the model's `fillable`, every foreign key the
 *   client sends must name a row the caller may `view`, unique checks with a friendly 422, and a
 *   409 when a race still hits the unique index. The write and a re-read of the row through
 *   `view` (and `update`, after an update) share one transaction: a row the write moved out of
 *   the caller's reach is rolled back with a 403;
 * - **field-level read rules:** the policy's `readableFields(user)` limits what lists, single
 *   records and included relations return, and what may be filtered, sorted or searched;
 * - **deny by default:** the policy is the controller's `policy`, else the registered or
 *   discovered one (`app/policies/post.policy.ts`); a missing method denies.
 *
 * It is a normal class you own and override, not a black box: every step is a protected method.
 * It talks to the ORM only through the {@link ResourceModel} contract.
 *
 * @module
 */

import {
  allows,
  authorize,
  hasAdminRole,
  listScope,
  needsViewScope,
  type Policy,
  PolicyDenial,
  readableFieldsFor,
  unscopedViewMessage,
} from '../../auth/gate.ts'
import { PolicyRegistryToken } from '../../auth/policies.ts'
import type { IssueInput } from '../../core/errors/errors.ts'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../core/errors/errors.ts'
import { camelCase } from '../../core/inflection.ts'
import { BootError } from '../../foundation/boot-error.ts'
import { currentApplication } from '../../foundation/current.ts'
import type { AuthUser } from '../../foundation/registry.ts'
import { UrlGeneratorToken } from '../../routing/url.ts'
import type { FormRequest } from '../../validation/form-request.ts'
import { MetadataRequest } from '../../validation/from-metadata.ts'
import type { HttpContext } from './context.ts'
import type {
  Constraint,
  IncludeAccess,
  ResourceMetadata,
  ResourceModel,
  ResourceReadAccess,
  ResourceRecord,
} from './resource-model.ts'

/**
 * Laravel's base controller: empty on purpose. Extend it so every controller has one place to add
 * shared helpers later.
 *
 * @example
 * export class HomeController extends Controller {
 *   index(ctx: HttpContext): Response { return ctx.html('<div id="root"></div>') }
 * }
 */
export abstract class Controller {}

/**
 * The record type a resource model serves.
 *
 * @example
 * type R = RecordOf<typeof Post> // Post
 */
export type RecordOf<TModel> = TModel extends ResourceModel<infer TRecord> ? TRecord : never

/** A policy that denies everything: what a resource without any policy gets. */
const DENY_ALL: Policy<unknown> = Object.freeze({})

/** "Any of nothing": a constraint no row meets (a list scope of `'none'`). */
const NO_ROWS: Constraint = Object.freeze({ anyOf: Object.freeze([]) })

/**
 * Admins may do everything, everyone else nothing: the policy of a generated resource until the
 * app writes `app/policies/<model>.policy.ts` (blueprint §5: "generated policies allow only the
 * admin role until you edit them"). Admin means `hasAdminRole()`: `roles` includes `admin`.
 *
 * @example
 * await allows(ADMIN_ONLY, 'delete', user, post) // true only for an admin
 */
export const ADMIN_ONLY: Policy<unknown> = Object.freeze({
  before: (user: AuthUser | null): boolean => hasAdminRole(user),
})

/**
 * The base for CRUD controllers. Set `model`; set `policy` or let it be discovered; optionally
 * `storeRequest`, `updateRequest`, `indexConstraints()` and `prepareForStore()`.
 *
 * @example
 * export class PostController extends ResourceController<typeof Post> {
 *   protected readonly model = Post
 * }
 * // routes/api.ts: Route.apiResource('posts', PostController)
 */
export abstract class ResourceController<
  TModel extends ResourceModel<ResourceRecord>,
> extends Controller {
  /** The model class this controller serves. */
  protected abstract readonly model: TModel
  /** The policy that guards every action; when unset, the registered or discovered one. */
  protected readonly policy: Policy<RecordOf<TModel>> | undefined = undefined
  /** Validation for `store`; derived from the metadata when not set. */
  protected readonly storeRequest: FormRequest<object> | undefined = undefined
  /** Validation for `update`; derived from the metadata when not set. */
  protected readonly updateRequest: FormRequest<object> | undefined = undefined

  /**
   * `GET /posts`: one page of the records this user may see.
   *
   * @example
   * // GET /api/posts?search=hello&sort=-created_at&filter[status]=published
   */
  async index(ctx: HttpContext): Promise<Response> {
    const policy = await this.resolvedPolicy()
    await authorize(policy, 'viewAny', ctx.user)
    const access = await this.readAccess(ctx, policy)
    const constraints = [
      ...(await this.scopeConstraints(policy, ctx.user)),
      ...(await this.indexConstraints(ctx)),
    ]
    const page = await this.model.paginate(ctx.query, constraints, access)
    // The scope is `view` in SQL; `view` itself still has the last word on every row.
    const data: RecordOf<TModel>[] = []
    for (const record of page.data as readonly RecordOf<TModel>[])
      if (await allows(policy, 'view', ctx.user, record)) data.push(record)
    return ctx.json({ data, meta: page.meta })
  }

  /**
   * `GET /posts/{post}`: the bound record, if the policy's `view` allows it.
   *
   * @example
   * // GET /api/posts/hello-world
   */
  async show(ctx: HttpContext): Promise<Response> {
    const record = await this.visible(ctx)
    await this.present(ctx, record)
    return ctx.json({ data: record })
  }

  /**
   * `POST /posts`: validate, check uniques, create, and answer 201 with a `Location` header.
   *
   * @example
   * // POST /api/posts {"title": "Hello"}
   */
  async store(ctx: HttpContext): Promise<Response> {
    await authorize(await this.resolvedPolicy(), 'create', ctx.user)
    const request = this.storeRequest ?? this.defaultRequest('create')
    const input = this.massAssignable(await request.validate(ctx))
    await this.assertReferencesVisible(input, ctx)
    const values = await this.prepareForStore({ ...input }, ctx)
    await this.assertUnique(values, undefined)
    const record = await this.model.transaction(async () => {
      const created = (await this.withConflictHandling(() =>
        this.model.createFromValidated(values),
      )) as RecordOf<TModel>
      // `view` only: a policy may allow creating rows it never lets anyone change.
      await this.assertStillReachable(ctx, created, ['view'])
      return created
    })
    await this.present(ctx, record, false)
    return ctx.json({ data: record }, 201, this.locationHeader(ctx, record))
  }

  /**
   * `PUT/PATCH /posts/{post}`: validate (every field optional), check uniques, save.
   *
   * @example
   * // PATCH /api/posts/hello-world {"status": "published"}
   */
  async update(ctx: HttpContext): Promise<Response> {
    const record = await this.visible(ctx)
    await authorize(await this.resolvedPolicy(), 'update', ctx.user, record)
    const request = this.updateRequest ?? this.defaultRequest('update')
    const input = this.massAssignable(await request.validate(ctx))
    await this.assertReferencesVisible(input, ctx)
    const values = await this.prepareForUpdate({ ...input }, record, ctx)
    await this.assertUnique(values, record)
    await this.model.transaction(async () => {
      await this.withConflictHandling(() => record.updateFromValidated(values))
      await this.assertStillReachable(ctx, record, ['view', 'update'])
    })
    await this.present(ctx, record)
    return ctx.json({ data: record })
  }

  /**
   * `DELETE /posts/{post}`: delete (softly when the table has `deleted_at`), then 204.
   *
   * @example
   * // DELETE /api/posts/hello-world
   */
  async destroy(ctx: HttpContext): Promise<Response> {
    const record = await this.visible(ctx)
    await authorize(await this.resolvedPolicy(), 'delete', ctx.user, record)
    await record.delete()
    return ctx.noContent()
  }

  /**
   * `POST /posts/{post}/restore`: bring a soft-deleted record back, if the policy's `view` and
   * `restore` allow it. The route binds with trashed rows (`.withTrashed()`, which the generated
   * resource routes set); on a table without soft deletes there is nothing to restore (404).
   *
   * @example
   * // routes: Route.post('/posts/{post}/restore', [PostController, 'restore']).withTrashed()
   */
  async restore(ctx: HttpContext): Promise<Response> {
    const record = await this.visible(ctx)
    await authorize(await this.resolvedPolicy(), 'restore', ctx.user, record)
    if (this.model.metadata().softDeletes !== true || typeof record.restore !== 'function')
      throw new NotFoundError(this.label())
    await this.withConflictHandling(async () => {
      await record.restore?.()
    })
    await this.present(ctx, record)
    return ctx.json({ data: record })
  }

  /**
   * What this user may read, decided from the policies before any row is loaded: the policy's
   * readable fields, and for every `?include=` the related model's own policy, deny by default.
   * An include needs `viewAny` there (403 otherwise) and shows only the related rows that
   * policy's list scope and `view` allow, with its readable fields: an include must never show
   * rows or fields the related resource's own API would refuse (security review F-02). Names the
   * model refuses are left to the model, which reports them as 422 `include_not_allowed`.
   *
   * @example
   * const access = await this.readAccess(ctx, await this.resolvedPolicy())
   */
  protected async readAccess(
    ctx: HttpContext,
    policy: Policy<RecordOf<TModel>>,
  ): Promise<ResourceReadAccess> {
    const includes = new Map<string, IncludeAccess>()
    const raw = ctx.query.get('include')
    if (raw !== null && raw !== '' && this.model.includable !== undefined) {
      const registry = currentApplication(this.constructor.name).container.make(PolicyRegistryToken)
      for (const name of new Set(raw.split(',').map((part) => part.trim()))) {
        const related = this.model.includable(name)
        if (related === undefined) continue
        const relatedPolicy = (await registry.discover(related)) ?? DENY_ALL
        await authorize(relatedPolicy, 'viewAny', ctx.user)
        includes.set(name, {
          constraints: await this.scopeConstraints(relatedPolicy, ctx.user),
          readable: await readableFieldsFor(relatedPolicy, ctx.user),
          visible: (record) => allows(relatedPolicy, 'view', ctx.user, record),
        })
      }
    }
    return { readable: await readableFieldsFor(policy, ctx.user), includes }
  }

  /**
   * A policy's list scope as constraints: none for `'all'`, one no row meets for `'none'`.
   * Throws (a 500; boot refuses it first) when `view` reads the record without a `viewScope`.
   *
   * @example
   * const constraints = await this.scopeConstraints(policy, ctx.user)
   */
  protected async scopeConstraints<TRecord>(
    policy: Policy<TRecord>,
    user: AuthUser | null,
  ): Promise<readonly Constraint[]> {
    const scope = await listScope(policy, user)
    if (scope === 'all') return []
    if (scope === 'none') return [NO_ROWS]
    return scope
  }

  /**
   * Apply `?include=` / `?fields=` and the read access to a single record, when the model
   * supports them. `withQuery: false` (after a store) applies only the field-level read rules.
   *
   * @example
   * await this.present(ctx, record)
   */
  protected async present(
    ctx: HttpContext,
    record: RecordOf<TModel>,
    withQuery = true,
  ): Promise<void> {
    if (this.model.present === undefined) return
    const policy = await this.resolvedPolicy()
    if (!withQuery) {
      const readable = await readableFieldsFor(policy, ctx.user)
      await this.model.present(record, new URLSearchParams(), { readable, includes: new Map() })
      return
    }
    await this.model.present(record, ctx.query, await this.readAccess(ctx, policy))
  }

  /**
   * Every foreign key the client sent must name a row the caller may `view` under the related
   * model's own policy (its discovered policy, else the generated admins-only default). Missing
   * and not visible answer alike, 422 `not_found` on the field, so ids can't be probed. Values
   * set by server code (`prepareForStore`) are trusted and not checked.
   *
   * @example
   * await this.assertReferencesVisible(input, ctx)
   */
  protected async assertReferencesVisible(
    input: Readonly<Record<string, unknown>>,
    ctx: HttpContext,
  ): Promise<void> {
    const issues: IssueInput[] = []
    for (const field of this.model.metadata().fields) {
      if (field.references === undefined || !Object.hasOwn(input, field.name)) continue
      const value = input[field.name]
      if (value === null || value === undefined) continue
      if (!(await this.referenceVisible(field.name, value, ctx.user)))
        issues.push({ path: [field.name], code: 'not_found' })
    }
    if (issues.length > 0) throw new ValidationError(issues)
  }

  /** Does `value` in the foreign key `column` name a row `user` may view? Fails closed. */
  private async referenceVisible(
    column: string,
    value: unknown,
    user: AuthUser | null,
  ): Promise<boolean> {
    const target = this.model.reference?.(column)
    if (target === undefined || (typeof value !== 'string' && typeof value !== 'number'))
      return false
    const found = await target.model.resolveRouteBinding(String(value), target.key)
    if (found === null) return false
    const registry = currentApplication(this.constructor.name).container.make(PolicyRegistryToken)
    const policy = (await registry.discover(target.model)) ?? ADMIN_ONLY
    return allows(policy, 'view', user, found)
  }

  /**
   * Inside the write's transaction: read the row again and require `abilities` on what is now
   * stored. A write that moved the row out of the caller's reach (another owner, status or
   * tenant) throws 403, which rolls the transaction back, so it is never committed.
   *
   * @example
   * await this.assertStillReachable(ctx, record, ['view', 'update'])
   */
  protected async assertStillReachable(
    ctx: HttpContext,
    record: RecordOf<TModel>,
    abilities: readonly ('view' | 'update')[],
  ): Promise<void> {
    const key = this.model.metadata().primaryKey
    const fresh = await this.model.resolveRouteBinding(String(record.routeKey(key)), key)
    const policy = await this.resolvedPolicy()
    for (const ability of abilities)
      if (fresh === null || !(await allows(policy, ability, ctx.user, fresh)))
        throw new ForbiddenError({
          cause: new PolicyDenial(
            `After this write ${policy.constructor.name}.${ability}() no longer allows this ${this.label()} for the user, so the write was rolled back.`,
          ),
        })
  }

  /**
   * Extra list conditions, for rows this user may see. Default: none.
   *
   * @example
   * protected override indexConstraints(ctx: HttpContext): Constraint[] {
   *   return [{ anyOf: [{ column: 'status', equals: 'published' }, { column: 'author_id', equals: ctx.user?.id ?? null }] }]
   * }
   */
  protected indexConstraints(
    _ctx: HttpContext,
  ): readonly Constraint[] | Promise<readonly Constraint[]> {
    return []
  }

  /**
   * Adjust validated values before insert, for example to set the owner from the signed-in user.
   * This is server code: it may set columns the client can't (`author_id`).
   *
   * @example
   * protected override prepareForStore(values, ctx) { return { ...values, author_id: ctx.requireUser().id } }
   */
  protected prepareForStore(
    values: Record<string, unknown>,
    _ctx: HttpContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    return values
  }

  /**
   * Adjust validated values before an update.
   *
   * @example
   * protected override prepareForUpdate(values) { return { ...values, edited: true } }
   */
  protected prepareForUpdate(
    values: Record<string, unknown>,
    _record: RecordOf<TModel>,
    _ctx: HttpContext,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    return values
  }

  /**
   * The resource this controller serves. The app checks it at boot (internal tables are refused).
   *
   * @example
   * new PostController().resourceMetadata().table // 'posts'
   */
  resourceMetadata(): ResourceMetadata {
    return this.model.metadata()
  }

  /**
   * The model class, for boot checks and policy discovery.
   *
   * @example
   * new PostController().resourceModel().name // 'Post'
   */
  resourceModel(): ResourceModel<ResourceRecord> {
    return this.model
  }

  /**
   * The controller's own `policy`, if it set one (boot uses it to skip discovery).
   *
   * @example
   * controller.explicitPolicy() // PostPolicy instance or undefined
   */
  explicitPolicy(): Policy<RecordOf<TModel>> | undefined {
    return this.policy
  }

  /**
   * The policy in force: the controller's own, else the registered or discovered one
   * (`app/policies/<model>.policy.ts`, found once and cached), else one that denies everything.
   *
   * @example
   * await authorize(await this.resolvedPolicy(), 'publish', ctx.user, post)
   */
  protected async resolvedPolicy(): Promise<Policy<RecordOf<TModel>>> {
    if (this.policy !== undefined) return this.policy
    const registry = currentApplication(this.constructor.name).container.make(PolicyRegistryToken)
    const policy = await registry.discover(this.model)
    return (policy ?? this.fallbackPolicy() ?? DENY_ALL) as Policy<RecordOf<TModel>>
  }

  /**
   * The policy when neither the controller nor `app/policies` has one. `undefined` (the default)
   * makes boot fail with `missing_policy`, so a hand-written controller can't go live unguarded.
   * Generated controllers ({@link resourceController}) answer {@link ADMIN_ONLY}: deny by default,
   * admins only, until the app writes its policy (blueprint §5).
   *
   * @example
   * protected override fallbackPolicy() { return ADMIN_ONLY }
   */
  fallbackPolicy(): Policy<RecordOf<TModel>> | undefined {
    return undefined
  }

  /**
   * The bound record, if the user may `view` it. A record the user may not see answers exactly
   * like a missing one (Laravel's `denyAsNotFound`), so the ids and slugs of hidden rows can't be
   * probed through show, update, delete or custom actions (security review F-23). A record the
   * user *can* see but not change still gets an honest 403 from the next check.
   *
   * @example
   * const post = await this.visible(ctx) // then: await authorize(await this.resolvedPolicy(), 'update', …)
   */
  protected async visible(ctx: HttpContext): Promise<RecordOf<TModel>> {
    const record = this.bound(ctx)
    if (await allows(await this.resolvedPolicy(), 'view', ctx.user, record)) return record
    throw new NotFoundError(this.label())
  }

  /**
   * The record bound to the route's last parameter (binding already answered 404 if it didn't
   * exist).
   *
   * @example
   * const post = this.bound(ctx)
   */
  protected bound(ctx: HttpContext): RecordOf<TModel> {
    const parameter = this.parameterName(ctx)
    const record = ctx.bound(parameter)
    if (record === undefined)
      throw new BootError(
        'model_not_bound',
        `${this.constructor.name} needs {${parameter}} bound to ${this.model.name} on ${ctx.route?.uri ?? ctx.url.pathname}.`,
        `Add it in bootstrap/app.ts: withRouting({ bindings: { ${parameter}: ${this.model.name} } }).`,
      )
    return record as RecordOf<TModel>
  }

  /**
   * The route parameter holding the record (the last one in the path: `post` in /posts/{post}).
   *
   * @example
   * this.parameterName(ctx) // 'post'
   */
  protected parameterName(ctx: HttpContext): string {
    return Object.keys(ctx.params).at(-1) ?? ''
  }

  /**
   * The singular label in lower case, for messages (`post`).
   *
   * @example
   * this.label() // 'post'
   */
  protected label(): string {
    return this.model.metadata().label.singular.toLowerCase()
  }

  /**
   * The default form request, derived from the metadata and narrowed by the model's `fillable`.
   *
   * @example
   * this.defaultRequest('create')
   */
  protected defaultRequest(mode: 'create' | 'update'): FormRequest<object> {
    return new MetadataRequest(this.model.metadata(), mode, this.model.fillable)
  }

  /**
   * Mass assignment only through `fillable`: when the model lists it, a validated key outside it
   * is refused (422 `unknown_field`), even if a hand-written form request accepted it.
   *
   * @example
   * const input = this.massAssignable(await request.validate(ctx))
   */
  protected massAssignable(input: object): Record<string, unknown> {
    const values = { ...(input as Record<string, unknown>) }
    const fillable = this.model.fillable
    if (fillable === undefined) return values
    const refused: IssueInput[] = Object.keys(values)
      .filter((key) => !fillable.includes(key))
      .map((key) => ({ path: [key], code: 'unknown_field' }))
    if (refused.length > 0) throw new ValidationError(refused)
    return values
  }

  /**
   * Check unique columns before writing, so a duplicate is a friendly 422 on the right field
   * instead of a driver error. A race between two requests still hits the unique index; that is
   * caught by {@link withConflictHandling} as a 409.
   *
   * @example
   * await this.assertUnique(values, undefined)
   */
  protected async assertUnique(
    values: Readonly<Record<string, unknown>>,
    current: RecordOf<TModel> | undefined,
  ): Promise<void> {
    const resource = this.model.metadata()
    const issues: IssueInput[] = []
    const exceptKey = current?.routeKey(resource.primaryKey)
    for (const field of resource.fields) {
      const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined
      if (!field.unique || (typeof value !== 'string' && typeof value !== 'number')) continue
      if (await this.model.isTaken(field.name, value, exceptKey))
        issues.push({ path: [field.name], code: 'unique' })
    }
    if (issues.length > 0) throw new ValidationError(issues)
  }

  /**
   * Run a write and turn a unique-index violation into a 409 `conflict`. The error text differs
   * per engine (SQLite "UNIQUE constraint failed", MySQL "Duplicate entry"/1062, PostgreSQL 23505).
   *
   * @example
   * await this.withConflictHandling(() => record.updateFromValidated(values))
   */
  protected async withConflictHandling<TResult>(write: () => Promise<TResult>): Promise<TResult> {
    try {
      return await write()
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code
      if (
        error instanceof Error &&
        (/UNIQUE constraint failed|Duplicate entry/.test(error.message) ||
          code === '23505' ||
          code === 'ER_DUP_ENTRY')
      )
        throw new ConflictError('conflict', undefined, { cause: error })
      throw error
    }
  }

  /**
   * `Location: /api/posts/hello-world` when the resource has a named `show` route.
   *
   * @example
   * this.locationHeader(ctx, record) // { location: '/api/posts/hello-world' }
   */
  protected locationHeader(ctx: HttpContext, record: RecordOf<TModel>): Record<string, string> {
    const storeName = ctx.route?.name
    if (storeName === undefined || !storeName.endsWith('.store')) return {}
    const showName = `${storeName.slice(0, -'.store'.length)}.show`
    const urls = currentApplication('ResourceController.store()').container.make(UrlGeneratorToken)
    const parameters = urls.parameters(showName)
    const last = parameters.at(-1)
    if (last === undefined) return {}
    const params: Record<string, string | ResourceRecord> = { [last]: record }
    // A nested show route needs its parents from this request; a shallow one needs none.
    for (const name of parameters.slice(0, -1)) params[name] = ctx.param(name)
    return { location: urls.route(showName, params) }
  }
}

/**
 * Boot checks for a resource controller's access rules, so a misconfigured resource never
 * serves a request:
 *
 * - `view_scope_missing`: the policy's `view` reads the record but there is no `viewScope`, so
 *   `index` can't be limited to the rows `view` allows (a list would show rows `view` refuses).
 * - `unresolved_reference`: a writable foreign key whose target model can't be found (no
 *   `belongsTo` named like the column), so the "caller may view the row it points at" check
 *   could never pass.
 *
 * @example
 * checkResourceAccess('PostController', Post, Post.metadata(), new PostPolicy())
 */
export function checkResourceAccess(
  controllerName: string,
  model: ResourceModel<ResourceRecord>,
  resource: ResourceMetadata,
  policy: Policy<never>,
): void {
  if (needsViewScope(policy))
    throw new BootError(
      'view_scope_missing',
      `${controllerName} lists ${model.name} records, but ${unscopedViewMessage(policy.constructor.name)}`,
      'A list must never show a row view() refuses, so the resource is not served until the policy says which rows it may list.',
    )
  const fillable = model.fillable
  for (const field of resource.fields) {
    const writable =
      !field.hidden &&
      field.kind !== 'id' &&
      (fillable === undefined ? field.fillable : fillable.includes(field.name))
    if (field.references === undefined || !writable) continue
    if (model.reference?.(field.name) === undefined) {
      const relation = camelCase(field.name.replace(/_id$/, ''))
      throw new BootError(
        'unresolved_reference',
        `${controllerName} lets clients write ${model.name}.${field.name}, a foreign key to "${field.references}", but ${model.name} has no relation that says which model that is.`,
        `Add the relation to the model, named like the column: ${relation}() { return this.belongsTo(<Model of ${field.references}>, '${field.name}') }. Every id a client writes is checked against that model's view() policy.`,
      )
    }
  }
}

/** One generated controller class per model, so every route of a resource shares it. */
const generatedControllers = new WeakMap<object, new () => ResourceController<never>>()

/**
 * A ready `ResourceController` for a model, with nothing to write: what the generated
 * `routes/resources.gen.ts` uses for every model without its own controller. Calling it twice
 * with the same model returns the same class, so the resource and its `restore` route share one
 * controller (and its boot checks).
 *
 * @example
 * const CustomerController = resourceController(Customer)
 * Route.apiResource('customers', CustomerController)
 */
export function resourceController<TModel extends ResourceModel<ResourceRecord>>(
  model: TModel,
): new () => ResourceController<TModel> {
  const cached = generatedControllers.get(model) as
    | (new () => ResourceController<TModel>)
    | undefined
  if (cached !== undefined) return cached
  class GeneratedResourceController extends ResourceController<TModel> {
    protected readonly model: TModel = model
    override fallbackPolicy(): Policy<RecordOf<TModel>> {
      return ADMIN_ONLY
    }
  }
  // `CustomerController` in route:list, boot errors and logs, as if it were written by hand.
  Object.defineProperty(GeneratedResourceController, 'name', { value: `${model.name}Controller` })
  generatedControllers.set(
    model,
    GeneratedResourceController as unknown as new () => ResourceController<never>,
  )
  return GeneratedResourceController
}
