/**
 * The resource engine: every model gets list, show, create, update, delete and restore routes,
 * plus `POST /<path>/query` for filter trees, all running the same pipeline (docs/06 §5.3):
 *
 * `parse → validate → authorize → scope (tenant + policy filter) → hooks.before → write
 * (in a transaction: the row, then onWrite hooks) → commit → after-commit hooks and event
 * (failures logged, never sent) → serialize`
 *
 * Authorization is two-step and deny-by-default:
 * 1. Is the action allowed at all? `create`: `can(actor, "<model>.create", input)`. Row actions (list,
 *    show, update, delete, restore): `can()` allows it, or the row filter of step 2 is not FALSE (a
 *    conditional rule such as "members update their own records" cannot be decided without the
 *    record). Otherwise 401 (anonymous) or 403. Update, delete and restore are re-checked with the
 *    record itself.
 * 2. `filterFor(actor, …)` narrows which rows the action may touch; a row outside it is a 404,
 *    exactly like a row that does not exist, so ids cannot be probed.
 *
 * Routes are documented through `@hono/zod-openapi`'s registry; the handlers parse and validate
 * themselves so every failure, including malformed JSON, becomes an RFC-0003 problem.
 *
 * @module
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Actor, Logger, PermissionProvider, QueryFilter } from '../contracts/index.ts'
import {
  type Application,
  type EventBus,
  ForbiddenError,
  type HookRegistry,
  NotFoundError,
  StrutvaneError,
  UnauthenticatedError,
  ValidationError,
} from '../core/index.ts'
import {
  createRepository,
  type DataRecord,
  type Repository,
  type Scope,
  type WriteOptions,
} from '../data/repository.ts'
import type { Database } from '../database/types.ts'
import type { ModelDefinition } from '../model/define-model.ts'
import type { ModelRegistry } from '../model/registry.ts'
import { issuesFromZod, modelLabels, modelSchemas } from '../model/schemas.ts'
import { andAll, type BoundFilter, bindFilter } from '../query/bind.ts'
import { clientQueryFields, narrowQueryFields, type QueryField } from '../query/fields.ts'
import { normalizeError } from './errors.ts'
import { type ParsedListQuery, parseListQuery, serializeListParams } from './list-query.ts'
import { permissionFor } from './permissions.ts'
import { policyFilterFor } from './policy-filter.ts'
import {
  ACTION_PERMISSIONS,
  type ResolvedResource,
  type ResourceAction,
  type ResourceContext,
  routeEnabled,
  type WriteChange,
  type WriteContext,
} from './resource.ts'

/** Per-request state set by the app middleware. */
export interface RequestState {
  readonly requestId: string
  readonly locale: string
  readonly actor: Actor | null
  readonly tenantId: string | undefined
  /** The client address (socket peer, or a trusted proxy hop); never from headers alone. */
  readonly clientAddress?: string
  /** Field labels for problem messages, set by the handler that knows the resource. */
  labels?: Readonly<Record<string, string>>
}

/**
 * What runtime adapters pass as Hono's `c.env`: this package's `serve` passes `clientAddress`
 * (already resolved); `@hono/node-server` passes `incoming` (the Node request).
 */
export interface HttpBindings {
  readonly clientAddress?: string | undefined
  /** The TCP peer address (this package's `serve`), never from headers. */
  readonly ip?: string | undefined
  readonly incoming?: { readonly socket?: { readonly remoteAddress?: string | undefined } }
}

/** Hono environment for framework apps. */
export interface HttpEnv {
  Bindings: HttpBindings
  Variables: { sv: RequestState }
}

/**
 * The `resource.onWrite` hook payload: run inside the write's transaction for every create,
 * update, delete and restore made through the API. This is where audit belongs (an audit sink
 * bound to `db` writes in the same transaction, so audit and data never disagree). Throwing rolls
 * the write back.
 */
export interface ResourceOnWritePayload {
  readonly resource: string
  /** The permission type (`deal`). */
  readonly type: string
  readonly action: WriteChange['action']
  readonly record: DataRecord
  readonly previous?: DataRecord
  readonly actor: Actor | null
  readonly tenantId: string | undefined
  readonly requestId: string
  /** The model's `audit` option. */
  readonly audited: boolean
  /** The transaction the write runs in. */
  readonly db: Database
}

/**
 * The `resource.afterCommit` hook payload: run after the commit. Handlers observe; a failure is
 * logged and never changes the response.
 */
export type ResourceAfterCommitPayload = Omit<ResourceOnWritePayload, 'db'>

/** Deepest row an offset page may reach (`page[number] × page[size]`); use cursors beyond it. */
export const MAX_OFFSET = 10_000

/** The `after*` hook name per write action, for after-commit failure logs. */
const LEGACY_HOOK: Readonly<Record<WriteChange['action'], string>> = {
  create: 'afterCreate',
  update: 'afterUpdate',
  delete: 'afterDelete',
  restore: 'afterRestore',
}

/**
 * Most children one `hasMany` include loads per request (one batched query for the whole page).
 * Over it the children are cut and the response says so: `meta.truncated` on a list, the
 * `Strutvane-Truncated-Includes` header on a single record.
 */
export const MAX_INCLUDED_CHILDREN = 1000

/** The header naming the relations a single-record response cut at {@link MAX_INCLUDED_CHILDREN}. */
const TRUNCATED_HEADER = 'Strutvane-Truncated-Includes'

/** Most relations one request may include. */
const MAX_INCLUDES = 10

/** What the engine needs (resolved once by `createHttpApp`). */
export interface EngineDeps {
  readonly db: Database
  readonly registry: ModelRegistry
  readonly permissions: PermissionProvider
  readonly hooks: HookRegistry<Record<string, unknown>>
  readonly events: EventBus<Record<string, unknown>>
  readonly ids: () => string
  readonly now: () => Date
  readonly logger: Logger
  readonly basePath: string
  /** The booted application, handed to hooks. */
  readonly app: Application
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Read and parse a JSON body; 415 for other media types, 400 for malformed JSON. */
export async function readJsonBody(c: Context): Promise<unknown> {
  const type = c.req.header('content-type') ?? ''
  if (!JSON_TYPE.test(type)) {
    throw new StrutvaneError('unsupported_media_type', {
      status: 415,
      params: { expected: 'application/json' },
    })
  }
  const text = await c.req.text()
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new StrutvaneError('malformed_request', { status: 400, cause: error })
  }
}

/** Body of `POST /<path>/query`. */
const QueryBody = z.strictObject({
  filter: z.unknown().optional(),
  search: z.string().max(200).optional(),
  sort: z
    .array(z.strictObject({ field: z.string().max(64), direction: z.enum(['asc', 'desc']) }))
    .max(5)
    .optional(),
  page: z
    .union([
      z.strictObject({
        size: z.int().min(1).max(100).optional(),
        cursor: z.string().max(2048).optional(),
      }),
      z.strictObject({
        size: z.int().min(1).max(100).optional(),
        number: z.int().min(1).max(100_000),
      }),
    ])
    .optional(),
  include: z.array(z.string().max(64)).max(10).optional(),
  total: z.boolean().optional(),
})

/** Register every enabled route of one resource on `app`. */
export function registerResourceRoutes(
  app: OpenAPIHono<HttpEnv>,
  resource: ResolvedResource,
  deps: EngineDeps,
): void {
  const model = resource.definition
  const base = `${deps.basePath}/${model.path}`
  const schemas = modelSchemas(model)
  const labels = modelLabels(model)
  // Client queries never reference hidden fields; trusted policy filters use queryFields().
  const fields = clientQueryFields(model)
  const includes = resource.includes ?? []
  const maxPageSize = Math.min(resource.pageSize?.max ?? 100, 100)
  const repo = createRepository({
    db: deps.db,
    model,
    registry: deps.registry,
    ids: deps.ids,
    now: deps.now,
  })
  const repos = new Map<string, Repository>([[model.name, repo]])
  const repoFor = (target: ModelDefinition): Repository => {
    let r = repos.get(target.name)
    if (!r) {
      r = createRepository({
        db: deps.db,
        model: target,
        registry: deps.registry,
        ids: deps.ids,
        now: deps.now,
      })
      repos.set(target.name, r)
    }
    return r
  }

  const state = (c: Context<HttpEnv>): RequestState => {
    const s = c.get('sv')
    s.labels = labels
    return s
  }
  const nameOf = (target: Parameters<ResourceContext['repositoryFor']>[0]): string =>
    typeof target === 'string'
      ? target
      : 'definition' in target
        ? target.definition.name
        : target.name
  const ctxOf = (s: RequestState): ResourceContext => ({
    model,
    actor: s.actor,
    tenantId: s.tenantId,
    requestId: s.requestId,
    locale: s.locale,
    repository: repo,
    repositoryFor: (target) => repoFor(deps.registry.require(nameOf(target))),
    scope: s.tenantId !== undefined ? { tenantId: s.tenantId } : {},
    app: deps.app,
  })

  /** The context for `onWrite`: every repository writes through the transaction `tx`. */
  const writeCtxOf = (s: RequestState, tx: Database): WriteContext => {
    const onTx = (target: ModelDefinition): Repository =>
      createRepository({
        db: tx,
        model: target,
        registry: deps.registry,
        ids: deps.ids,
        now: deps.now,
      })
    return {
      ...ctxOf(s),
      db: tx,
      repository: onTx(model),
      repositoryFor: (target) => onTx(deps.registry.require(nameOf(target))),
    }
  }

  /**
   * Stage 1, inside the transaction: the resource's `onWrite`, then `resource.onWrite` handlers
   * (audit). Any throw rolls the write back.
   */
  const inTransaction = (
    s: RequestState,
    action: WriteChange['action'],
    previous?: DataRecord,
  ): WriteOptions => ({
    onWrite: async (record, tx) => {
      const change: WriteChange = { action, record, ...(previous ? { previous } : {}) }
      await resource.hooks?.onWrite?.(change, writeCtxOf(s, tx))
      const payload: ResourceOnWritePayload = {
        resource: model.name,
        type: model.permission,
        action,
        record,
        ...(previous ? { previous } : {}),
        actor: s.actor,
        tenantId: s.tenantId,
        requestId: s.requestId,
        audited: model.options.audit,
        db: tx,
      }
      await deps.hooks.run('resource.onWrite', payload)
    },
  })

  /**
   * Stage 2, after the commit: the `after*` hook, `afterCommit`, `resource.afterCommit` handlers
   * and the domain event, each on its own. The write has happened, so a failure is logged and
   * never changes the response: a 500 here would make the client retry a write that succeeded.
   */
  const afterCommit = async (
    s: RequestState,
    change: WriteChange,
    legacy: (() => void | Promise<void>) | undefined,
    event: string,
  ): Promise<void> => {
    const payload: ResourceAfterCommitPayload = {
      resource: model.name,
      type: model.permission,
      action: change.action,
      record: change.record,
      ...(change.previous ? { previous: change.previous } : {}),
      actor: s.actor,
      tenantId: s.tenantId,
      requestId: s.requestId,
      audited: model.options.audit,
    }
    const own = resource.hooks?.afterCommit
    const steps: (readonly [string, (() => unknown) | undefined])[] = [
      [LEGACY_HOOK[change.action], legacy],
      ['afterCommit', own && (() => own(change, ctxOf(s)))],
      ['resource.afterCommit', () => deps.hooks.run('resource.afterCommit', payload)],
      ['event', () => emit(event, change.record, s)],
    ]
    for (const [stage, run] of steps) {
      if (!run) continue
      try {
        await run()
      } catch (error) {
        deps.logger.error('A hook failed after the commit; the write itself succeeded', {
          stage,
          resource: model.name,
          action: change.action,
          id: change.record.id,
          requestId: s.requestId,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
        })
      }
    }
  }

  /** Step 1: may the actor perform this action at all? */
  const authorize = async (
    s: RequestState,
    action: ResourceAction,
    record?: Record<string, unknown>,
  ): Promise<void> => {
    const decision = await deps.permissions.can(
      s.actor,
      permissionFor(model.permission, ACTION_PERMISSIONS[action]),
      { type: model.permission, ...(record ? { record } : {}) },
    )
    if (!decision.allowed)
      throw s.actor === null ? new UnauthenticatedError() : new ForbiddenError()
  }

  /**
   * Step 1 for actions on rows (list, show, update, delete, restore): is the actor allowed to
   * perform it on SOME rows? A record-less `can()` cannot answer that for conditional rules
   * ("members update their own deals": auth answers `record-required`), so the action is allowed
   * when `can()` allows it OR the row filter is not FALSE. Which rows is then decided by that
   * filter (outside it: 404), and update/delete/restore are re-checked with the record itself.
   */
  const authorizeRows = async (s: RequestState, action: ResourceAction): Promise<void> => {
    const decision = await deps.permissions.can(
      s.actor,
      permissionFor(model.permission, ACTION_PERMISSIONS[action]),
      { type: model.permission },
    )
    if (decision.allowed) return
    const filter = await deps.permissions.filterFor(
      s.actor,
      permissionFor(model.permission, ACTION_PERMISSIONS[action]),
      model.permission,
    )
    if (filter.op === 'false' || s.actor === null)
      throw s.actor === null ? new UnauthenticatedError() : new ForbiddenError()
  }

  /**
   * Step 2: which rows may this action touch? The PermissionProvider's filter AND whatever the
   * `resource.beforeQuery` hook returns: a hook can only narrow the policy, never replace or
   * widen it (a buggy or hostile hook returning `{ op: 'true' }` changes nothing).
   */
  const policyFilter = (
    target: ModelDefinition,
    s: RequestState,
    suffix: string,
  ): Promise<BoundFilter> => policyFilterFor(deps, target, s.actor, suffix)

  /**
   * The visibility each referenced row must have: for every `belongsTo` value in `values`, the
   * target's `view` policy (so a client cannot link to, or learn about, rows it may not see).
   */
  const referenceFilters = async (
    values: Readonly<Record<string, unknown>>,
    s: RequestState,
  ): Promise<Record<string, BoundFilter>> => {
    const out: Record<string, BoundFilter> = {}
    for (const [key, def] of Object.entries(model.fields)) {
      if (def.kind !== 'belongsTo' || values[key] === null || values[key] === undefined) continue
      const target = deps.registry.get(def.target ?? '')
      if (target) out[key] = await policyFilter(target, s, ACTION_PERMISSIONS.show)
    }
    return out
  }

  /** Reject a list request the resource does not allow (deep offsets, totals). */
  const checkListCost = (query: ParsedListQuery, where: 'query' | 'body'): void => {
    const at = (...path: string[]) => (where === 'query' ? ['query', ...path] : path)
    const issues: { path: string[]; code: string; params?: Record<string, number> }[] = []
    if (query.page?.kind === 'offset' && query.page.number * query.page.size > MAX_OFFSET) {
      issues.push({
        path: at('page', 'number'),
        code: 'page_too_deep',
        params: { max: MAX_OFFSET },
      })
    }
    if (query.withTotal && resource.allowTotal !== true) {
      issues.push({
        path: where === 'query' ? at('page', 'total') : ['total'],
        code: 'total_not_allowed',
      })
    }
    if (issues.length > 0) throw new ValidationError(issues)
  }

  const scopeFor = async (
    s: RequestState,
    suffix: string,
    extra: Partial<Scope> = {},
  ): Promise<Scope> => ({
    ...(s.tenantId !== undefined ? { tenantId: s.tenantId } : {}),
    filter: await policyFilter(model, s, suffix),
    ...extra,
  })

  /** Remove hidden fields, run `resource.serialize` hooks (auth strips field-level reads). */
  const serializeRecord = async (
    target: ModelDefinition,
    record: Record<string, unknown>,
    s: RequestState,
  ): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) {
      if (k === 'included') continue
      if (target.fields[k]?.hidden) continue
      out[k] = v
    }
    const hooked = (await deps.hooks.run('resource.serialize', {
      resource: target.name,
      type: target.permission,
      actor: s.actor,
      record: out,
    })) as {
      record: Record<string, unknown>
    }
    return hooked.record
  }

  const respond = async (
    record: DataRecord,
    s: RequestState,
    included?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    let out = await serializeRecord(model, record, s)
    if (included) out = { ...out, included }
    const transformed = await resource.hooks?.transformResponse?.(out, ctxOf(s))
    return transformed ?? out
  }

  /**
   * Load allow-listed relations for a page of records, batched (no N+1), in scope. `truncated`
   * names the `hasMany` relations cut at {@link MAX_INCLUDED_CHILDREN}.
   */
  const loadIncludes = async (
    records: readonly DataRecord[],
    names: readonly string[],
    s: RequestState,
  ): Promise<{ byRecord: Map<string, Record<string, unknown>>; truncated: string[] }> => {
    const byRecord = new Map<string, Record<string, unknown>>(records.map((r) => [r.id, {}]))
    const truncated: string[] = []
    for (const name of names) {
      const fieldDef = model.fields[name]
      if (fieldDef?.kind === 'belongsTo') {
        const target = deps.registry.require(fieldDef.target ?? '')
        const ids = records.map((r) => r[name]).filter((v): v is string => typeof v === 'string')
        const scope: Scope = {
          ...(s.tenantId !== undefined ? { tenantId: s.tenantId } : {}),
          filter: await policyFilter(target, s, 'view'),
        }
        const found = new Map((await repoFor(target).findMany(ids, scope)).map((r) => [r.id, r]))
        for (const r of records) {
          const hit = typeof r[name] === 'string' ? found.get(r[name] as string) : undefined
          const slot = byRecord.get(r.id) as Record<string, unknown>
          slot[name] = hit ? await serializeRecord(target, hit, s) : null
        }
        continue
      }
      const relation = model.relations[name]
      if (!relation) continue
      const target = deps.registry.require(relation.target)
      const scope: Scope = {
        ...(s.tenantId !== undefined ? { tenantId: s.tenantId } : {}),
        filter: await policyFilter(target, s, 'viewAny'),
      }
      // One more than the cap: finding it is how a cut is detected (never silent).
      const found = await repoFor(target).findBy(
        relation.foreignKey,
        records.map((r) => r.id),
        scope,
        MAX_INCLUDED_CHILDREN + 1,
      )
      if (found.length > MAX_INCLUDED_CHILDREN) truncated.push(name)
      const children = found.slice(0, MAX_INCLUDED_CHILDREN)
      for (const r of records) (byRecord.get(r.id) as Record<string, unknown>)[name] = []
      for (const child of children) {
        const parent = byRecord.get(child[relation.foreignKey] as string)
        if (parent) (parent[name] as unknown[]).push(await serializeRecord(target, child, s))
      }
    }
    return { byRecord, truncated }
  }

  /**
   * `resource.beforeWrite`: the last check before a create or update reaches the database.
   * Handlers refuse a write by throwing a Strutvane error (auth uses it for field-level write
   * rules); they cannot change the input. `input` holds only the validated, client-sent fields.
   */
  const beforeWrite = async (
    action: 'create' | 'update',
    input: Readonly<Record<string, unknown>>,
    s: RequestState,
  ): Promise<void> => {
    await deps.hooks.run('resource.beforeWrite', {
      resource: model.name,
      type: model.permission,
      action,
      actor: s.actor,
      tenantId: s.tenantId,
      input: Object.freeze({ ...input }),
    })
  }

  const emit = async (event: string, record: DataRecord, s: RequestState): Promise<void> => {
    await deps.events.emit(`${model.permission}.${event}`, {
      resource: model.name,
      id: record.id,
      tenantId: s.tenantId ?? null,
      actorId: s.actor?.id ?? null,
    })
  }

  const findVisible = async (
    id: string,
    s: RequestState,
    suffix: string,
    trashed?: Scope['trashed'],
  ): Promise<DataRecord> => {
    if (!UUID.test(id)) throw new NotFoundError(model.label)
    const scope = await scopeFor(s, suffix, trashed ? { trashed } : {})
    const found = await repo.find(id, scope)
    if (!found) throw new NotFoundError(model.label)
    return found
  }

  /**
   * The fields this actor may reference in a list query: {@link clientQueryFields} intersected
   * with `PermissionProvider.filterableFields` when the provider implements it (field-level
   * read rules, e.g. from @strutvane/auth). Resolved once per request, never per field.
   * `allowed` is undefined when the provider does not narrow.
   */
  const clientFieldsFor = async (
    s: RequestState,
  ): Promise<{
    readonly fields: ReadonlyMap<string, QueryField>
    readonly allowed: ReadonlySet<string> | undefined
  }> => {
    const allowed = await deps.permissions.filterableFields?.(s.actor, model.permission)
    return { fields: narrowQueryFields(fields, allowed), allowed }
  }

  /**
   * An include reveals which record is linked to which, so it needs the link field to be readable
   * (`PermissionProvider.filterableFields`, the actor's readable fields): the `belongsTo` field on
   * this model, or the target's foreign key for a `hasMany` relation. Otherwise the include is
   * refused exactly like an unknown one (`include_not_allowed`), even though the field itself is
   * stripped from the serialized record. Providers without `filterableFields` do not narrow.
   */
  const assertReadableIncludes = async (
    s: RequestState,
    names: readonly string[],
    allowed: ReadonlySet<string> | undefined,
    path: readonly string[],
  ): Promise<void> => {
    for (const name of names) {
      const relation = model.relations[name]
      const readable = relation
        ? await deps.permissions.filterableFields?.(
            s.actor,
            deps.registry.require(relation.target).permission,
          )
        : allowed
      const link = relation ? relation.foreignKey : name
      if (readable !== undefined && !readable.has(link)) {
        throw new ValidationError([
          { path: [...path], code: 'include_not_allowed', params: { relation: name } },
        ])
      }
    }
  }

  const runList = async (
    c: Context<HttpEnv>,
    query: ParsedListQuery,
    where: 'query' | 'body',
    client: Awaited<ReturnType<typeof clientFieldsFor>>,
  ): Promise<Response> => {
    const s = state(c)
    await authorizeRows(s, 'list')
    checkListCost(query, where)
    await assertReadableIncludes(
      s,
      query.include ?? [],
      client.allowed,
      where === 'query' ? ['query', 'include'] : ['include'],
    )
    await resource.hooks?.beforeList?.(ctxOf(s))
    try {
      const userFilter = query.filter
        ? bindFilter(query.filter, { fields: client.fields, operators: 'declared', actor: s.actor })
        : undefined
      const scope = await scopeFor(s, ACTION_PERMISSIONS.list)
      const page = await repo.list(
        {
          ...(userFilter ? { filter: andAll([userFilter]) } : {}),
          ...(query.search !== undefined ? { search: query.search } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          ...(query.page ? { page: query.page } : {}),
          ...(client.allowed ? { allowedFields: client.allowed } : {}),
          withTotal: query.withTotal,
        },
        scope,
      )
      const inc =
        query.include && query.include.length > 0
          ? await loadIncludes(page.data, query.include, s)
          : undefined
      const data = await Promise.all(page.data.map((r) => respond(r, s, inc?.byRecord.get(r.id))))
      const next =
        page.page.nextCursor !== undefined
          ? `${base}?${serializeListParams({ page: { size: page.page.size, cursor: page.page.nextCursor } })}`
          : undefined
      return c.json(
        {
          data,
          meta: {
            page: page.page,
            ...(inc && inc.truncated.length > 0 ? { truncated: inc.truncated } : {}),
          },
          ...(next && where === 'query' ? { links: { next } } : {}),
        },
        200,
      )
    } catch (error) {
      throw normalizeError(error, where)
    }
  }

  const listRules = {
    fields,
    includes,
    ...(resource.pageSize?.max !== undefined ? { maxPageSize: resource.pageSize.max } : {}),
    ...(resource.pageSize?.default !== undefined
      ? { defaultPageSize: resource.pageSize.default }
      : {}),
  }

  if (routeEnabled(resource, 'list')) {
    app.get(base, async (c) => {
      const client = await clientFieldsFor(state(c))
      const parsed = parseListQuery(new URL(c.req.url).searchParams, {
        ...listRules,
        fields: client.fields,
      })
      if (!parsed.ok) throw new ValidationError(parsed.issues)
      return runList(c, parsed.query, 'query', client)
    })
    app.post(`${base}/query`, async (c) => {
      state(c)
      const raw = await readJsonBody(c)
      const body = QueryBody.safeParse(raw)
      if (!body.success) throw new ValidationError(issuesFromZod(body.error.issues, [], raw))
      const b = body.data
      for (const inc of b.include ?? []) {
        if (!includes.includes(inc)) {
          throw new ValidationError([
            { path: ['include'], code: 'include_not_allowed', params: { relation: inc } },
          ])
        }
      }
      if (b.page?.size !== undefined && b.page.size > maxPageSize) {
        throw new ValidationError([
          { path: ['page', 'size'], code: 'invalid_page_size', params: { max: maxPageSize } },
        ])
      }
      const size = b.page?.size ?? Math.min(resource.pageSize?.default ?? 25, maxPageSize)
      const query: ParsedListQuery = {
        ...(b.filter !== undefined ? { filter: b.filter as QueryFilter } : {}),
        ...(b.search !== undefined && b.search.trim() !== '' ? { search: b.search } : {}),
        ...(b.sort ? { sort: b.sort } : {}),
        page:
          b.page && 'number' in b.page
            ? { kind: 'offset', size, number: b.page.number }
            : {
                kind: 'cursor',
                size,
                ...(b.page?.cursor !== undefined ? { cursor: b.page.cursor } : {}),
              },
        ...(b.include ? { include: [...new Set(b.include)] } : {}),
        withTotal: b.total === true,
      }
      return runList(c, query, 'body', await clientFieldsFor(state(c)))
    })
  }

  if (routeEnabled(resource, 'show')) {
    app.get(`${base}/:id`, async (c) => {
      const s = state(c)
      await authorizeRows(s, 'show')
      const id = c.req.param('id')
      await resource.hooks?.beforeShow?.(id, ctxOf(s))
      const record = await findVisible(id, s, ACTION_PERMISSIONS.show)
      const includeParam = new URL(c.req.url).searchParams.get('include')
      const names = includeParam ? [...new Set(includeParam.split(','))] : []
      if (names.length > MAX_INCLUDES) {
        throw new ValidationError([
          { path: ['query', 'include'], code: 'too_many_includes', params: { max: MAX_INCLUDES } },
        ])
      }
      for (const n of names) {
        if (!includes.includes(n)) {
          throw new ValidationError([
            { path: ['query', 'include'], code: 'include_not_allowed', params: { relation: n } },
          ])
        }
      }
      if (names.length > 0) {
        const allowed = await deps.permissions.filterableFields?.(s.actor, model.permission)
        await assertReadableIncludes(s, names, allowed, ['query', 'include'])
      }
      const loaded = names.length > 0 ? await loadIncludes([record], names, s) : undefined
      if (loaded && loaded.truncated.length > 0)
        c.header(TRUNCATED_HEADER, loaded.truncated.join(','))
      return c.json(await respond(record, s, loaded?.byRecord.get(record.id)), 200)
    })
  }

  if (routeEnabled(resource, 'create')) {
    app.post(base, async (c) => {
      const s = state(c)
      // Anonymous callers are authorized before validation: issues would describe the schema
      // (field names, types, what is required) to someone who may not create anything. An
      // authenticated caller is validated first and authorized with the input (record rules).
      if (s.actor === null) await authorize(s, 'create')
      const raw = await readJsonBody(c)
      const parsed = schemas.create.safeParse(raw)
      if (!parsed.success) throw new ValidationError(issuesFromZod(parsed.error.issues, [], raw))
      let input = parsed.data as Record<string, unknown>
      await authorize(s, 'create', input)
      await beforeWrite('create', input, s)
      input = (await resource.hooks?.beforeCreate?.(input, ctxOf(s))) ?? input
      // The created row must satisfy the create policy (checked in the transaction) and may only
      // reference rows the actor can see.
      const created = await repo.create(
        input,
        {
          ...(s.tenantId !== undefined ? { tenantId: s.tenantId } : {}),
          check: await policyFilter(model, s, ACTION_PERMISSIONS.create),
          references: await referenceFilters(input, s),
        },
        inTransaction(s, 'create'),
      )
      const afterCreate = resource.hooks?.afterCreate
      await afterCommit(
        s,
        { action: 'create', record: created },
        afterCreate && (() => afterCreate(created, ctxOf(s))),
        'created',
      )
      c.header('Location', `${base}/${created.id}`)
      return c.json(await respond(created, s), 201)
    })
  }

  if (routeEnabled(resource, 'update')) {
    app.patch(`${base}/:id`, async (c) => {
      const s = state(c)
      // Authorized first: a caller who may update nothing gets 401/403, never the field-level
      // validation issues that would describe the resource's schema.
      await authorizeRows(s, 'update')
      const raw = await readJsonBody(c)
      const parsed = schemas.update.safeParse(raw)
      if (!parsed.success) throw new ValidationError(issuesFromZod(parsed.error.issues, [], raw))
      const existing = await findVisible(c.req.param('id'), s, ACTION_PERMISSIONS.update)
      await beforeWrite('update', parsed.data as Record<string, unknown>, s)
      let patch = parsed.data as Record<string, unknown>
      patch = (await resource.hooks?.beforeUpdate?.(patch, existing, ctxOf(s))) ?? patch
      // Record-level authorization sees the row as it would be after the change.
      await authorize(s, 'update', { ...existing, ...patch })
      // `filter` doubles as the check: the updated row must still be one the actor may update,
      // so a patch cannot move it out of scope (e.g. hand it to another owner).
      const updated = await repo.update(
        existing.id,
        patch,
        await scopeFor(s, ACTION_PERMISSIONS.update, {
          references: await referenceFilters(patch, s),
        }),
        inTransaction(s, 'update', existing),
      )
      if (!updated) throw new NotFoundError(model.label)
      const afterUpdate = resource.hooks?.afterUpdate
      await afterCommit(
        s,
        { action: 'update', record: updated, previous: existing },
        afterUpdate && (() => afterUpdate(updated, existing, ctxOf(s))),
        'updated',
      )
      return c.json(await respond(updated, s), 200)
    })
  }

  if (routeEnabled(resource, 'delete')) {
    app.delete(`${base}/:id`, async (c) => {
      const s = state(c)
      await authorizeRows(s, 'delete')
      const existing = await findVisible(c.req.param('id'), s, ACTION_PERMISSIONS.delete)
      await authorize(s, 'delete', existing)
      await resource.hooks?.beforeDelete?.(existing, ctxOf(s))
      const deleted = await repo.delete(
        existing.id,
        await scopeFor(s, ACTION_PERMISSIONS.delete),
        inTransaction(s, 'delete'),
      )
      if (!deleted) throw new NotFoundError(model.label)
      const afterDelete = resource.hooks?.afterDelete
      await afterCommit(
        s,
        { action: 'delete', record: existing },
        afterDelete && (() => afterDelete(existing, ctxOf(s))),
        'deleted',
      )
      return c.body(null, 204)
    })
  }

  if (routeEnabled(resource, 'restore')) {
    app.post(`${base}/:id/restore`, async (c) => {
      const s = state(c)
      await authorizeRows(s, 'restore')
      const existing = await findVisible(c.req.param('id'), s, ACTION_PERMISSIONS.restore, 'only')
      await authorize(s, 'restore', existing)
      await resource.hooks?.beforeRestore?.(existing, ctxOf(s))
      const restored = await repo.restore(
        existing.id,
        await scopeFor(s, ACTION_PERMISSIONS.restore),
        inTransaction(s, 'restore'),
      )
      if (!restored) throw new NotFoundError(model.label)
      const afterRestore = resource.hooks?.afterRestore
      await afterCommit(
        s,
        { action: 'restore', record: restored },
        afterRestore && (() => afterRestore(restored, ctxOf(s))),
        'restored',
      )
      return c.json(await respond(restored, s), 200)
    })
  }
}
