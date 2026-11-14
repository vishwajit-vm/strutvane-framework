/**
 * OpenAPI 3.1 for the resource API (ADR-0011), served at `/openapi.json`.
 *
 * Routes are registered in `@hono/zod-openapi`'s registry from the same Zod schemas the handlers
 * validate with, so documentation and behaviour cannot disagree. The generated document is then
 * extended deterministically with:
 * - `x-strutvane` (document): where the manifest lives and which list protocol is used;
 * - `x-strutvane-resource`, `x-strutvane-action`, `x-strutvane-permission` (operations);
 * - `x-strutvane-field` (schema properties): type, label, filter operators, sort/search flags;
 * - the list-query parameters, marked `x-strutvane-serialization: strutvane-list-query`,
 *   because OpenAPI's `deepObject` style defines only one nesting level.
 *
 * Every error response is `application/problem+json` with the RFC 9457 + RFC-0003 schema.
 *
 * @module
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import { z } from 'zod'
import { LIST_QUERY_LIMITS, MANIFEST_PATH, PROBLEM_CONTENT_TYPE } from '../contracts/index.ts'
import {
  ACTION_PERMISSIONS,
  type ResolvedResource,
  type ResourceAction,
  routeEnabled,
} from '../http/resource.ts'
import type { HttpEnv } from '../http/resource-routes.ts'
import { modelSchemas } from '../model/schemas.ts'
import { queryFields } from '../query/fields.ts'

/** The generated document type. */
export type OpenApiDocument = ReturnType<OpenAPIHono['getOpenAPI31Document']>

/** RFC 9457 problem with RFC-0003 issues. */
export const ProblemSchema: z.ZodType = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.int(),
    code: z.string(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    traceId: z.string().optional(),
    issues: z
      .array(
        z.object({
          path: z.array(z.union([z.string(), z.int()])),
          code: z.string(),
          message: z.string(),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        }),
      )
      .optional(),
  })
  .meta({ description: 'An RFC 9457 problem with RFC-0003 validation issues.' })

const problem = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema } },
})

const idParam = z.object({ id: z.uuid().meta({ description: 'Record id (UUIDv7)' }) })

/** Register the documentation of a resource's routes. */
export function documentResource(
  app: OpenAPIHono<HttpEnv>,
  resource: ResolvedResource,
  basePath: string,
): void {
  const model = resource.definition
  const registry = app.openAPIRegistry
  const s = modelSchemas(model)
  const read = registry.register(
    model.name,
    s.read.extend({ included: z.record(z.string(), z.unknown()).optional() }),
  )
  const create = registry.register(`${model.name}Create`, s.create)
  const update = registry.register(`${model.name}Update`, s.update)
  const list = registry.register(
    `${model.name}List`,
    z.object({
      data: z.array(read),
      meta: z.object({
        page: z.object({
          size: z.int(),
          hasMore: z.boolean(),
          nextCursor: z.string().optional(),
          number: z.int().optional(),
          total: z.int().optional(),
        }),
      }),
      links: z.object({ next: z.string().optional() }).optional(),
    }),
  )
  const base = `${basePath}/${model.path}`
  const tags = [model.pluralLabel]
  const json = (schema: z.ZodType, description: string) => ({
    description,
    content: { 'application/json': { schema } },
  })
  const common = {
    401: problem('Sign-in required'),
    403: problem('Not allowed'),
    500: problem('Unexpected error'),
  }
  const op = (action: ResourceAction, summary: string) => ({
    operationId: `${action}${action === 'list' ? model.pluralLabel.replace(/\W/g, '') : model.name}`,
    summary,
    tags,
  })

  if (routeEnabled(resource, 'list')) {
    registry.registerPath({
      method: 'get',
      path: base,
      ...op('list', `List ${model.pluralLabel.toLowerCase()}`),
      responses: {
        200: json(list, 'One page of results'),
        422: problem('Invalid filter, sort or page'),
        ...common,
      },
    })
    registry.registerPath({
      method: 'post',
      path: `${base}/query`,
      operationId: `query${model.pluralLabel.replace(/\W/g, '')}`,
      summary: `Query ${model.pluralLabel.toLowerCase()} with a filter tree`,
      tags,
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({
                filter: z
                  .record(z.string(), z.unknown())
                  .optional()
                  .meta({ description: 'A QueryFilter tree' }),
                search: z.string().max(200).optional(),
                sort: z
                  .array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']) }))
                  .optional(),
                page: z
                  .object({
                    size: z.int().optional(),
                    cursor: z.string().optional(),
                    number: z.int().optional(),
                  })
                  .optional(),
                include: z.array(z.string()).optional(),
                total: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(list, 'One page of results'),
        400: problem('Malformed JSON'),
        422: problem('Invalid query'),
        ...common,
      },
    })
  }
  if (routeEnabled(resource, 'show')) {
    registry.registerPath({
      method: 'get',
      path: `${base}/{id}`,
      ...op('show', `Get one ${model.label.toLowerCase()}`),
      request: { params: idParam },
      responses: { 200: json(read, model.label), 404: problem('Not found'), ...common },
    })
  }
  if (routeEnabled(resource, 'create')) {
    registry.registerPath({
      method: 'post',
      path: base,
      ...op('create', `Create a ${model.label.toLowerCase()}`),
      request: { body: { required: true, content: { 'application/json': { schema: create } } } },
      responses: {
        201: json(read, 'Created'),
        400: problem('Malformed JSON'),
        415: problem('Body is not JSON'),
        422: problem('Validation failed'),
        ...common,
      },
    })
  }
  if (routeEnabled(resource, 'update')) {
    registry.registerPath({
      method: 'patch',
      path: `${base}/{id}`,
      ...op('update', `Update a ${model.label.toLowerCase()}`),
      request: {
        params: idParam,
        body: { required: true, content: { 'application/json': { schema: update } } },
      },
      responses: {
        200: json(read, 'Updated'),
        400: problem('Malformed JSON'),
        404: problem('Not found'),
        415: problem('Body is not JSON'),
        422: problem('Validation failed'),
        ...common,
      },
    })
  }
  if (routeEnabled(resource, 'delete')) {
    registry.registerPath({
      method: 'delete',
      path: `${base}/{id}`,
      ...op('delete', `Delete a ${model.label.toLowerCase()}`),
      request: { params: idParam },
      responses: {
        204: { description: 'Deleted' },
        404: problem('Not found'),
        409: problem('Still referenced'),
        ...common,
      },
    })
  }
  if (routeEnabled(resource, 'restore')) {
    registry.registerPath({
      method: 'post',
      path: `${base}/{id}/restore`,
      ...op('restore', `Restore a deleted ${model.label.toLowerCase()}`),
      request: { params: idParam },
      responses: { 200: json(read, 'Restored'), 404: problem('Not found'), ...common },
    })
  }
}

/** Options for {@link buildOpenApiDocument}. */
export interface DocumentInfo {
  readonly title: string
  readonly version: string
  readonly description?: string
}

type Json = Record<string, unknown>

/** Generate the document and add the Strutvane extensions. Deterministic for the same input. */
export function buildOpenApiDocument(
  app: OpenAPIHono<HttpEnv>,
  resources: readonly ResolvedResource[],
  basePath: string,
  info: DocumentInfo,
): OpenApiDocument {
  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      description:
        info.description ??
        'Generated from Strutvane models. Errors are RFC 9457 problem+json with RFC-0003 issues.',
    },
  })
  const out = doc as unknown as Json & {
    paths?: Record<string, Record<string, Json>>
    components?: { schemas?: Record<string, Json> }
  }
  out['x-strutvane'] = { manifest: MANIFEST_PATH, listProtocol: 'strutvane-list-query' }

  for (const resource of resources) {
    const model = resource.definition
    const base = `${basePath}/${model.path}`
    const ops: [string, string, ResourceAction][] = [
      [base, 'get', 'list'],
      [`${base}/query`, 'post', 'list'],
      [`${base}/{id}`, 'get', 'show'],
      [base, 'post', 'create'],
      [`${base}/{id}`, 'patch', 'update'],
      [`${base}/{id}`, 'delete', 'delete'],
      [`${base}/{id}/restore`, 'post', 'restore'],
    ]
    for (const [path, method, action] of ops) {
      const operation = out.paths?.[path]?.[method]
      if (!operation) continue
      operation['x-strutvane-resource'] = model.name
      operation['x-strutvane-action'] = action
      operation['x-strutvane-permission'] = `${model.permission}.${ACTION_PERMISSIONS[action]}`
    }
    const listOp = out.paths?.[base]?.['get']
    if (listOp) listOp['parameters'] = listParameters(resource)

    const fields = queryFields(model)
    for (const name of [model.name, `${model.name}Create`, `${model.name}Update`]) {
      const props = out.components?.schemas?.[name]?.['properties'] as
        | Record<string, Json>
        | undefined
      if (!props) continue
      for (const [key, prop] of Object.entries(props)) {
        const f = fields.get(key)
        if (!f) continue
        prop['x-strutvane-field'] = {
          type: f.def.kind,
          label: f.def.label ?? key,
          filterOperators: f.def.filterOperators,
          sortable: f.def.sortable,
          searchable: f.def.searchable,
          readOnly: f.def.readOnly || f.system,
          writeOnce: f.def.writeOnce,
          ...(f.def.kind === 'belongsTo' ? { relation: f.def.target } : {}),
        }
      }
    }
  }
  return doc
}

/** OpenAPI parameters documenting the list protocol for one resource. */
export function listParameters(resource: ResolvedResource): Json[] {
  const fields = queryFields(resource.definition)
  const filterProps: Record<string, Json> = {}
  for (const [key, f] of fields) {
    if (f.def.filterOperators.length === 0) continue
    const ops: Record<string, Json> = {}
    const value = valueSchema(f.def.kind, f.def.values)
    for (const op of f.def.filterOperators) {
      if (op === 'isNull' || op === 'isNotNull') ops[op] = { const: true }
      else if (op === 'contains' || op === 'startsWith' || op === 'endsWith')
        ops[op] = { type: 'string', minLength: 1, maxLength: 200 }
      else if (op === 'between') ops[op] = { type: 'array', items: value, minItems: 2, maxItems: 2 }
      else if (op === 'in' || op === 'nin')
        ops[op] = { type: 'array', items: value, minItems: 1, maxItems: 100 }
      else ops[op] = value
    }
    filterProps[key] = { type: 'object', properties: ops, additionalProperties: false }
  }
  const sortable = [...fields.values()]
    .filter((f) => f.def.sortable)
    .flatMap((f) => [f.key, `-${f.key}`])
  const searchable = [...fields.values()].filter((f) => f.def.searchable).map((f) => f.key)
  const params: Json[] = [
    {
      name: 'filter',
      in: 'query',
      required: false,
      style: 'deepObject',
      explode: true,
      description:
        'Row filter: `filter[<field>][<operator>]=<value>`. Repeat the key for `in`, `nin` and `between`; `isNull`/`isNotNull` take `true`.',
      schema: { type: 'object', properties: filterProps, additionalProperties: false },
      'x-strutvane-serialization': 'strutvane-list-query',
    },
    {
      name: 'sort',
      in: 'query',
      required: false,
      style: 'form',
      explode: false,
      description:
        'Comma-separated sort fields; prefix `-` for descending. An `id` tiebreak is always applied.',
      schema: { type: 'array', items: { type: 'string', enum: sortable }, maxItems: 5 },
    },
    {
      name: 'page',
      in: 'query',
      required: false,
      style: 'deepObject',
      explode: true,
      description: `\`page[size]\` (1–${LIST_QUERY_LIMITS.maxPageSize}), and either \`page[cursor]\` (opaque) or \`page[number]\`; \`page[total]=true\` adds a count.`,
      schema: {
        type: 'object',
        properties: {
          size: { type: 'integer', minimum: 1, maximum: LIST_QUERY_LIMITS.maxPageSize },
          cursor: { type: 'string' },
          number: { type: 'integer', minimum: 1 },
          total: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  ]
  if (searchable.length > 0) {
    params.push({
      name: 'search',
      in: 'query',
      required: false,
      description: `Case-insensitive text search in: ${searchable.join(', ')}.`,
      schema: { type: 'string', maxLength: 200 },
    })
  }
  if ((resource.includes ?? []).length > 0) {
    params.push({
      name: 'include',
      in: 'query',
      required: false,
      style: 'form',
      explode: false,
      description: 'Related records to embed under `included`.',
      schema: { type: 'array', items: { type: 'string', enum: [...(resource.includes ?? [])] } },
    })
  }
  return params
}

function valueSchema(kind: string, values: readonly string[] | undefined): Json {
  switch (kind) {
    case 'integer':
      return { type: 'integer' }
    case 'float':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'enum':
      return { type: 'string', enum: [...(values ?? [])] }
    case 'uuid':
    case 'belongsTo':
      return { type: 'string', format: 'uuid' }
    case 'date':
      return { type: 'string', format: 'date' }
    case 'datetime':
      return { type: 'string', format: 'date-time' }
    default:
      return { type: 'string' }
  }
}

/** What {@link documentCustomRoute} needs from a custom route definition. */
export interface CustomRouteDoc {
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete'
  readonly path: string
  readonly name?: string
  readonly permission?: string
  readonly public?: boolean
}

/**
 * Document a custom route (`app/http/routes/*.ts`) in `/openapi.json`: its path (`:id` →
 * `{id}`), parameters, who may call it (`x-strutvane-permission`, or public, or any signed-in
 * caller) and the problem responses every route can return. Handlers return free-form JSON, so the
 * success body is documented as any JSON value.
 */
export function documentCustomRoute(
  app: OpenAPIHono<HttpEnv>,
  route: CustomRouteDoc,
  basePath: string,
): void {
  const names = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string)
  const path = `${basePath}${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`
  const access = route.permission
    ? `Requires the \`${route.permission}\` permission.`
    : route.public
      ? 'Public: no sign-in needed.'
      : 'Requires a signed-in caller.'
  app.openAPIRegistry.registerPath({
    method: route.method,
    path,
    operationId:
      route.name?.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) =>
        c ? c.toUpperCase() : '',
      ) ??
      `${route.method}${path.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))}`,
    summary: route.name ?? `${route.method.toUpperCase()} ${route.path}`,
    description: `Custom route. ${access}`,
    tags: ['Custom routes'],
    ...(names.length > 0
      ? { request: { params: z.object(Object.fromEntries(names.map((n) => [n, z.string()]))) } }
      : {}),
    ...(route.permission ? { 'x-strutvane-permission': route.permission } : {}),
    responses: {
      200: { description: 'JSON result', content: { 'application/json': { schema: z.unknown() } } },
      204: { description: 'No content' },
      400: problem('Malformed request'),
      ...(route.public && !route.permission ? {} : { 401: problem('Sign-in required') }),
      ...(route.permission ? { 403: problem('Not allowed') } : {}),
      404: problem('Not found'),
      422: problem('Validation failed'),
    },
  })
}
