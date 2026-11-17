/**
 * Controllers: a plain `Controller` base (Laravel's empty `App\Http\Controllers\Controller`), and
 * `ResourceController`, which gives a model the five API actions with:
 *
 * - **index:** the model's own list query (search, sort, filters, pagination, every name checked
 *   against its allow-lists), plus per-controller constraints (`indexConstraints`), behind the
 *   policy's `viewAny`;
 * - **show / update / destroy:** the route-bound record, behind `view` / `update` / `delete`;
 *   a record the user may not `view` answers exactly like a missing one (404, `visible()`);
 * - **store / update:** form-request validation (yours, or derived from the metadata), unknown
 *   fields refused, mass assignment only through the model's `fillable`, unique checks with a
 *   friendly 422, and a 409 when a race still hits the unique index;
 * - **deny by default:** the policy is the controller's `policy`, else the registered or
 *   discovered one (`app/policies/post.policy.ts`); a missing method denies.
 *
 * It is a normal class you own and override, not a black box: every step is a protected method.
 * It talks to the ORM only through the {@link ResourceModel} contract.
 *
 * @module
 */

import { allows, authorize, type Policy } from '../../auth/gate.ts'
import { PolicyRegistryToken } from '../../auth/policies.ts'
import type { IssueInput } from '../../core/errors/errors.ts'
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/errors.ts'
import { BootError } from '../../foundation/boot-error.ts'
import { currentApplication } from '../../foundation/current.ts'
import { UrlGeneratorToken } from '../../routing/url.ts'
import type { FormRequest } from '../../validation/form-request.ts'
import { MetadataRequest } from '../../validation/from-metadata.ts'
import type { HttpContext } from './context.ts'
import type {
  Constraint,
  ResourceMetadata,
  ResourceModel,
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
    await authorize(await this.resolvedPolicy(), 'viewAny', ctx.user)
    const page = await this.model.paginate(ctx.query, await this.indexConstraints(ctx))
    return ctx.json({ data: page.data, meta: page.meta })
  }

  /**
   * `GET /posts/{post}`: the bound record, if the policy's `view` allows it.
   *
   * @example
   * // GET /api/posts/hello-world
   */
  async show(ctx: HttpContext): Promise<Response> {
    return ctx.json({ data: await this.visible(ctx) })
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
    const values = await this.prepareForStore({ ...input }, ctx)
    await this.assertUnique(values, undefined)
    const record = (await this.withConflictHandling(() =>
      this.model.createFromValidated(values),
    )) as RecordOf<TModel>
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
    const values = await this.prepareForUpdate({ ...input }, record, ctx)
    await this.assertUnique(values, record)
    await this.withConflictHandling(() => record.updateFromValidated(values))
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
    return (policy ?? DENY_ALL) as Policy<RecordOf<TModel>>
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
        issues.push({ path: [field.name], code: 'taken' })
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
