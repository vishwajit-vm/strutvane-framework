/**
 * `createHttpApp(app, options)`: the Hono host for a Strutvane application.
 *
 * It wires, in order: security headers → request context (request id, locale, the
 * `http.onRequest` hook that resolves actor and tenant) → body limits → resource routes →
 * `/openapi.json`, the manifest, `/health` and `/ready` → RFC 9457 problems for every failure
 * (validation, malformed JSON, unknown routes, unexpected exceptions).
 *
 * The result is a standard Hono app: `app.fetch` works with any runtime adapter, and
 * `app.request()` drives it in tests without a network.
 *
 * @module
 */
import { OpenAPIHono } from '@hono/zod-openapi'
import { type Actor, MANIFEST_PATH, type TenantContext } from '@strutvane/contracts'
import {
  type Application,
  ClockToken,
  ErrorRegistryToken,
  EventBusToken,
  HooksToken,
  IdGeneratorToken,
  LoggerToken,
  MessagesToken,
  negotiateLocale,
  runWithContext,
  StrutvaneError,
} from '@strutvane/core'
import { bodyLimit } from 'hono/body-limit'
import type { Database } from '../database/types.ts'
import { registerFrameworkErrors, withFrameworkMessages } from '../messages.ts'
import type { AnyModel } from '../model/define-model.ts'
import { createModelRegistry, type ModelRegistry } from '../model/registry.ts'
import {
  buildOpenApiDocument,
  documentResource,
  type OpenApiDocument,
} from '../openapi/document.ts'
import { buildManifest } from '../openapi/manifest.ts'
import { DatabaseToken, ModelRegistryToken } from '../tokens.ts'
import { normalizeError, problemResponse, toProblemBody } from './errors.ts'
import { resolvePermissionProvider } from './permissions.ts'
import { type ResourceConfig, resolveResources } from './resource.ts'
import { type HttpEnv, type RequestState, registerResourceRoutes } from './resource-routes.ts'
import { acceptRequestId, securityHeaders } from './security.ts'

/** Options for {@link createHttpApp}. */
export interface HttpAppOptions {
  /** Models or resource configs to expose. */
  readonly resources: readonly (ResourceConfig | AnyModel)[]
  /** Prefix for resource routes. Default `/api/v1`. */
  readonly basePath?: string
  /** `APP_ENV`. Default `process.env['APP_ENV']`, else `production` (fail closed). */
  readonly env?: string
  /** Serve without a PermissionProvider outside local development (explicit opt-in). */
  readonly publicApi?: boolean
  /** Maximum request body size in bytes. Default 1 MiB. */
  readonly bodyLimit?: number
  /** API title and version for OpenAPI and the manifest. */
  readonly info?: { readonly title: string; readonly version: string }
  /** Serve `/openapi.json`. Default `true`. */
  readonly openapi?: boolean
  /** Extra readiness checks for `/ready` (the database is always checked). */
  readonly readiness?: Readonly<Record<string, () => Promise<void>>>
  /** Override the database (default: `DatabaseToken`). */
  readonly database?: Database
  /** Override the model registry (default: `ModelRegistryToken`, else built from `resources`). */
  readonly registry?: ModelRegistry
}

/** The app returned by {@link createHttpApp}. */
export type HttpApp = OpenAPIHono<HttpEnv> & {
  /** The OpenAPI document (also served at `/openapi.json`). */
  readonly openApiDocument: () => OpenApiDocument
}

const DEFAULT_BODY_LIMIT = 1024 * 1024

/** Create the HTTP application for a booted Strutvane `Application`. */
export function createHttpApp(app: Application, options: HttpAppOptions): HttpApp {
  const env = options.env ?? process.env['APP_ENV'] ?? 'production'
  const basePath = (options.basePath ?? '/api/v1').replace(/\/+$/, '')
  const logger = app.make(LoggerToken)
  const permissions = resolvePermissionProvider(app, {
    env,
    publicApi: options.publicApi === true,
    logger,
  })
  const errors = app.make(ErrorRegistryToken)
  registerFrameworkErrors(errors)
  const messages = withFrameworkMessages(app.make(MessagesToken))
  const hooks = app.make(HooksToken)
  const events = app.make(EventBusToken)
  const ids = app.make(IdGeneratorToken)
  const clock = app.make(ClockToken)
  const db = options.database ?? app.make(DatabaseToken)
  const resources = resolveResources(options.resources)
  const registry =
    options.registry ??
    (app.container.has(ModelRegistryToken)
      ? app.make(ModelRegistryToken)
      : createModelRegistry(resources.map((r) => r.definition)))
  for (const r of resources) {
    if (!registry.get(r.definition.name))
      throw new Error(`Resource ${r.definition.name} is not in the model registry`)
  }
  const info = options.info ?? { title: 'Strutvane API', version: '1.0.0' }

  const http = new OpenAPIHono<HttpEnv>()

  http.use('*', securityHeaders())
  http.use('*', async (c, next) => {
    const requestId = acceptRequestId(c.req.header('x-request-id'), () => ids())
    const locale = negotiateLocale(c.req.header('accept-language'), messages.locales())
    const resolved = (await hooks.run('http.onRequest', {
      request: c.req.raw,
      actor: null,
      tenant: undefined,
    })) as { actor: Actor | null; tenant: TenantContext | undefined }
    const state: RequestState = {
      requestId,
      locale,
      actor: resolved.actor ?? null,
      tenantId: resolved.tenant?.id,
    }
    c.set('sv', state)
    await runWithContext(
      {
        requestId,
        traceId: requestId,
        locale,
        actor: state.actor,
        ...(resolved.tenant ? { tenant: resolved.tenant } : {}),
      },
      () => next(),
    )
    c.res.headers.set('X-Request-Id', requestId)
    await hooks.run('http.onResponse', { request: c.req.raw, status: c.res.status, requestId })
  })
  http.use(
    '*',
    bodyLimit({
      maxSize: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      onError: () => {
        throw new StrutvaneError('PAYLOAD_TOO_LARGE', { status: 413 })
      },
    }),
  )

  const deps = {
    db,
    registry,
    permissions,
    hooks,
    events,
    ids: () => ids(),
    now: () => new Date(clock.now()),
    logger,
    basePath,
  }
  for (const resource of resources) {
    registerResourceRoutes(http, resource, deps)
    documentResource(http, resource, basePath)
  }

  let cachedDoc: OpenApiDocument | undefined
  const openApiDocument = (): OpenApiDocument => {
    cachedDoc ??= buildOpenApiDocument(http, resources, basePath, info)
    return cachedDoc
  }
  if (options.openapi !== false) http.get('/openapi.json', (c) => c.json(openApiDocument()))

  http.get(MANIFEST_PATH, async (c) => {
    const manifest = await buildManifest(c.get('sv').actor, {
      app: { name: info.title, apiVersion: basePath.split('/').pop() ?? 'v1' },
      resources,
      permissions,
      hooks,
      now: () => new Date(clock.now()),
    })
    return c.json(manifest)
  })

  http.get('/health', (c) => c.json({ status: 'ok' }))
  http.get('/ready', async (c) => {
    const checks: Record<string, () => Promise<void>> = {
      database: async () => {
        await db.query('SELECT 1')
      },
      ...options.readiness,
    }
    const results: Record<string, 'ok' | 'failed'> = {}
    for (const [name, check] of Object.entries(checks)) {
      try {
        await withTimeout(check(), 5000)
        results[name] = 'ok'
      } catch (error) {
        results[name] = 'failed'
        logger.warn('Readiness check failed', {
          check: name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const ready = Object.values(results).every((r) => r === 'ok')
    return c.json({ status: ready ? 'ready' : 'unavailable', checks: results }, ready ? 200 : 503)
  })

  http.notFound((c) => {
    const s = c.get('sv')
    const problem = toProblemBody(new StrutvaneError('NOT_FOUND', { status: 404 }), {
      messages,
      registry: errors,
      locale: s?.locale ?? 'en',
      traceId: s?.requestId ?? ids(),
      instance: new URL(c.req.url).pathname,
    })
    return problemResponse(problem)
  })

  http.onError((raw, c) => {
    const s = c.get('sv') as RequestState | undefined
    const error = normalizeError(raw)
    const traceId = s?.requestId ?? ids()
    const problem = toProblemBody(error, {
      messages,
      registry: errors,
      locale: s?.locale ?? 'en',
      traceId,
      instance: new URL(c.req.url).pathname,
      ...(s?.labels ? { labels: s.labels } : {}),
    })
    if (problem.status >= 500) {
      logger.error('Unhandled error while serving a request', {
        traceId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        error:
          raw instanceof Error
            ? { name: raw.name, message: raw.message, stack: raw.stack }
            : String(raw),
      })
    }
    const response = problemResponse(problem, error)
    response.headers.set('X-Request-Id', traceId)
    return response
  })

  return Object.assign(http, { openApiDocument }) as HttpApp
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
