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
import {
  HTTP_HOOKS,
  type HttpRequestHookPayload,
  type HttpResponseHookPayload,
  MANIFEST_PATH,
} from '@strutvane/contracts'
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
  UnauthenticatedError,
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
import {
  type SignedFileOptions,
  serveSignedFile,
  signedFilePrefix,
} from '../storage/serve-signed.ts'
import { DatabaseToken, ModelRegistryToken } from '../tokens.ts'
import { normalizeError, problemResponse, toProblemBody } from './errors.ts'
import { resolvePermissionProvider } from './permissions.ts'
import {
  clientAddressOf,
  forwardedProtocol,
  parsePublicUrl,
  type TrustProxy,
  trustedHops,
} from './proxy.ts'
import { type ResourceConfig, resolveResources } from './resource.ts'
import {
  type HttpBindings,
  type HttpEnv,
  type RequestState,
  registerResourceRoutes,
} from './resource-routes.ts'
import { type RouteDefinition, registerCustomRoutes } from './route.ts'
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
  /**
   * Serve `/openapi.json`: `'public'` to anyone, `'authenticated'` only to identified callers
   * (anonymous requests get 401), `false` not at all. `true` (the default) means `'public'` when
   * `env` is `local` and `'authenticated'` everywhere else: the document lists every resource,
   * field and filter, which is a map an anonymous visitor of a production API does not need.
   */
  readonly openapi?: boolean | 'public' | 'authenticated'
  /**
   * Proxy hops in front of the app whose `X-Forwarded-For`, `X-Forwarded-Proto` and
   * `X-Request-Id` headers are believed (`true` = one). Default `false`: clients can send those
   * headers themselves, so without a proxy you control they are ignored. The client address
   * handed to `http.onRequest` (`clientAddress`) then always comes from the socket.
   */
  readonly trustProxy?: TrustProxy
  /**
   * The URL users reach the app at (e.g. `https://app.example.com`). When it is `https`, HSTS is
   * sent even though TLS ends at a proxy in front of the app.
   */
  readonly publicUrl?: string
  /**
   * Serve signed temporary file links (`disk.temporaryUrl(key)`) for these disks: each entry
   * mounts `GET <prefix>/*` (default prefix `/storage/<disk>`), verifying the signature and
   * streaming the file with `nosniff`, a sandboxing CSP and active content as an attachment.
   */
  readonly signedFiles?: readonly SignedFileOptions[]
  /** Extra readiness checks for `/ready` (the database is always checked). */
  readonly readiness?: Readonly<Record<string, () => Promise<void>>>
  /** Override the database (default: `DatabaseToken`). */
  readonly database?: Database
  /** Override the model registry (default: `ModelRegistryToken`, else built from `resources`). */
  readonly registry?: ModelRegistry
  /** Custom routes (`route.get(…)`), mounted under `basePath` before the CRUD routes. */
  readonly routes?: readonly RouteDefinition[]
}

/**
 * The hook payloads live in `@strutvane/contracts` (`http-hooks.ts`) so the framework and the
 * packages that handle them (auth, logs) compile against one definition. Re-exported here for
 * compatibility with code that imported them from the framework.
 */
export type { HttpRequestHookPayload, HttpResponseHookPayload }

/** Copy `extra` onto `target`, keeping every `Set-Cookie` separate. */
function appendHeaders(target: Headers, extra: Headers | undefined): void {
  if (!extra) return
  for (const cookie of extra.getSetCookie()) target.append('set-cookie', cookie)
  for (const [name, value] of extra) if (name !== 'set-cookie') target.set(name, value)
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
  const hops = trustedHops(options.trustProxy)
  const publicUrl = parsePublicUrl(options.publicUrl)
  const openapiMode =
    options.openapi === false
      ? false
      : options.openapi === 'public' || options.openapi === 'authenticated'
        ? options.openapi
        : env === 'local'
          ? 'public'
          : 'authenticated'

  const http = new OpenAPIHono<HttpEnv>()

  http.use(
    '*',
    securityHeaders({
      isHttps: (c) =>
        publicUrl?.protocol === 'https:' ||
        forwardedProtocol(
          c.req.header('x-forwarded-proto'),
          hops,
          new URL(c.req.url).protocol === 'https:' ? 'https' : 'http',
        ) === 'https',
    }),
  )
  http.use('*', async (c, next) => {
    // A client-sent id is only believed from a trusted proxy (else ids could be forged).
    const requestId = acceptRequestId(c.req.header('x-request-id'), () => ids(), hops > 0)
    const locale = negotiateLocale(c.req.header('accept-language'), messages.locales())
    const clientAddress = resolveClientAddress(c.env, c.req.header('x-forwarded-for'), hops)
    const initial: HttpRequestHookPayload = {
      request: c.req.raw,
      actor: null,
      tenant: undefined,
      ...(clientAddress !== undefined ? { clientAddress } : {}),
    }
    const resolved = ((await hooks.run(HTTP_HOOKS.request, initial)) ??
      initial) as HttpRequestHookPayload
    const state: RequestState = {
      requestId,
      locale,
      actor: resolved.actor ?? null,
      tenantId: resolved.tenant?.id,
      ...(clientAddress !== undefined ? { clientAddress } : {}),
    }
    c.set('sv', state)
    if (resolved.response instanceof Response) {
      // A hook answered the request (sign-in route, log viewer): copy it so headers are mutable.
      const answer = new Response(resolved.response.body, resolved.response)
      appendHeaders(answer.headers, resolved.headers)
      answer.headers.set('X-Request-Id', requestId)
      const done: HttpResponseHookPayload = { request: c.req.raw, status: answer.status, requestId }
      await hooks.run(HTTP_HOOKS.response, done)
      return answer
    }
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
    appendHeaders(c.res.headers, resolved.headers)
    c.res.headers.set('X-Request-Id', requestId)
    const done: HttpResponseHookPayload = { request: c.req.raw, status: c.res.status, requestId }
    await hooks.run(HTTP_HOOKS.response, done)
    return undefined
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
  for (const files of options.signedFiles ?? []) {
    http.on(['GET', 'HEAD'], `${signedFilePrefix(files)}/*`, (c) =>
      serveSignedFile(c.req.raw, files),
    )
  }
  registerCustomRoutes(http, options.routes ?? [], { basePath, permissions })
  for (const resource of resources) {
    registerResourceRoutes(http, resource, deps)
    documentResource(http, resource, basePath)
  }

  let cachedDoc: OpenApiDocument | undefined
  const openApiDocument = (): OpenApiDocument => {
    cachedDoc ??= buildOpenApiDocument(http, resources, basePath, info)
    return cachedDoc
  }
  if (openapiMode !== false) {
    http.get('/openapi.json', (c) => {
      if (openapiMode === 'authenticated' && c.get('sv').actor === null)
        throw new UnauthenticatedError()
      return c.json(openApiDocument())
    })
  }

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

/**
 * The client address for this request. An adapter that already resolved it (this package's
 * `serve`, which applies `trustProxy` itself) passes `clientAddress`; otherwise the socket peer
 * from `@hono/node-server`'s `incoming` is used, with trusted `X-Forwarded-For` hops applied.
 * Never read from headers alone.
 */
function resolveClientAddress(
  env: HttpBindings | undefined,
  forwardedFor: string | undefined,
  hops: number,
): string | undefined {
  if (env !== undefined && typeof env === 'object' && 'clientAddress' in env)
    return typeof env.clientAddress === 'string' ? env.clientAddress : undefined
  return clientAddressOf(env?.incoming?.socket?.remoteAddress, forwardedFor, hops)
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
