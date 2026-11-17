/**
 * `createHttpApp(app, options)`: the Hono host for a Strutvane application.
 *
 * It wires, in order: security headers → trusted hosts (400 for an unknown `Host`, in every
 * environment, `trusted-hosts.ts`) → request timeout → CSRF (unsafe requests carrying the
 * session cookie, `csrf.ts`) → request context (request id, locale, the `http.onRequest` hook
 * that resolves actor and tenant) → body limits → resource routes →
 * `/openapi.json` and `/docs`, the manifest, `/health` and `/ready` → RFC 9457 problems for every failure
 * (validation, malformed JSON, unknown routes, unexpected exceptions).
 *
 * The result is a standard Hono app: `app.fetch` works with any runtime adapter, and
 * `app.request()` drives it in tests without a network.
 *
 * @module
 */
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { matchedRoutes } from 'hono/route'
import {
  HTTP_HOOKS,
  type HttpRequestHookPayload,
  type HttpResponseHookPayload,
  MANIFEST_PATH,
} from '../contracts/index.ts'
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
} from '../core/index.ts'
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
import { firstAppEnv, processAppEnv } from '../runtime/app-env.ts'
import {
  type SignedFileOptions,
  serveSignedFile,
  signedFilePrefix,
} from '../storage/serve-signed.ts'
import { DatabaseToken, ModelRegistryToken } from '../tokens.ts'
import { type CsrfOptions, csrfProtection, exactOrigin, resolveCsrf } from './csrf.ts'
import { DOCS_PAGE_CSP, renderDocsPage } from './docs-page.ts'
import { normalizeError, problemResponse, toProblemBody } from './errors.ts'
import {
  type IdempotencyStore,
  IdempotencyStoreToken,
  idempotency,
  MemoryIdempotencyStore,
} from './idempotency.ts'
import { resolvePermissionProvider } from './permissions.ts'
import {
  forwardedClient,
  isTrustedProxy,
  parsePublicUrl,
  type ResolvedProxies,
  resolveTrustProxy,
  type TrustProxy,
} from './proxy.ts'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  requestTimeout,
  UPLOAD_REQUEST_TIMEOUT_MS,
} from './request-timeout.ts'
import { type ResourceConfig, resolveResources } from './resource.ts'
import {
  type HttpBindings,
  type HttpEnv,
  type RequestState,
  registerResourceRoutes,
} from './resource-routes.ts'
import { type RouteDefinition, registerCustomRoutes, routePattern } from './route.ts'
import { routerPath } from './router-path.ts'
import { acceptRequestId, securityHeaders } from './security.ts'
import { SessionCookieToken, sessionCookieName } from './session-cookie.ts'
import { createStaticFiles, type StaticFilesOptions } from './static-files.ts'
import { resolveTrustedHosts, trustedHostsGuard } from './trusted-hosts.ts'
import { isUiRequest, UI_FALLTHROUGH_HEADER, uiExcludedPaths } from './ui-paths.ts'

/** Options for {@link createHttpApp}. */
export interface HttpAppOptions {
  /** Models or resource configs to expose. */
  readonly resources: readonly (ResourceConfig | AnyModel)[]
  /** Prefix for resource routes. Default `/api/v1`. */
  readonly basePath?: string
  /**
   * `APP_ENV`. Default `process.env['APP_ENV']`, else `production` (fail closed). Trimmed and
   * lowercased; an empty value counts as unset.
   */
  readonly env?: string
  /** Serve without a PermissionProvider outside local development (explicit opt-in). */
  readonly publicApi?: boolean
  /** Maximum request body size in bytes. Default 1 MiB. */
  readonly bodyLimit?: number
  /**
   * Longest time (ms) the app may take to produce a response (headers; a streamed body is not
   * cut). After it the client gets a 503 problem. Default {@link DEFAULT_REQUEST_TIMEOUT_MS};
   * `0` disables it.
   */
  readonly requestTimeoutMs?: number
  /** API title and version for OpenAPI and the manifest. */
  readonly info?: { readonly title: string; readonly version: string }
  /**
   * Serve `/openapi.json` and the readable page at `/docs`: `'public'` to anyone, `'authenticated'` only to identified callers
   * (anonymous requests get 401), `false` not at all. `true` (the default) means `'public'` when
   * `env` is `local` and `'authenticated'` everywhere else: the document lists every resource,
   * field and filter, which is a map an anonymous visitor of a production API does not need.
   */
  readonly openapi?: boolean | 'public' | 'authenticated'
  /**
   * The proxies in front of the app whose `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`
   * and `X-Request-Id` headers are believed: a hop count (`true` = one) or, safer, the proxies'
   * addresses or CIDR ranges (`['10.0.0.0/8']`). Default `false`: clients can send those
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
  /**
   * Extra host names the app answers for (`config/app.ts` `trustedHosts`): exact names, or
   * `*.example.com` for every subdomain. `localhost`, `127.0.0.1`, `[::1]` and the `publicUrl`
   * host are always allowed; any other `Host` gets a 400 `untrusted_host` problem, in every
   * environment (DNS rebinding of a local dev server, host-header poisoning in production).
   */
  readonly trustedHosts?: readonly string[]
  /**
   * The secret behind CSRF tokens (`APP_KEY`; a purpose-bound subkey is derived from it). Default
   * `process.env.APP_KEY`; without one, a random key lives as long as the process.
   */
  readonly appKey?: string
  /**
   * The session cookie (`config/session.ts`): its base name, default `strutvane_session`. The
   * framework adds `__Host-` when `publicUrl` is https and publishes the result under
   * `SessionCookieToken`, the one source the session layer and the CSRF check both read.
   */
  readonly session?: { readonly cookie?: string }
  /**
   * CSRF protection for unsafe requests that carry the session cookie (on by default):
   * `except` lists callback paths a third party posts to, `origins` extra trusted origins.
   * `false` turns it off for the whole app (logged at boot; only for apps without cookies).
   */
  readonly csrf?: CsrfOptions | false
  /**
   * `Idempotency-Key` handling for POST and DELETE (on by default; a request without the header
   * is unaffected). `store` replaces the in-memory store (bound as `IdempotencyStoreToken`; a
   * cluster needs a shared one), `ttlMs` and `maxEntries` bound the memory store. `false` turns
   * it off.
   */
  readonly idempotency?:
    | {
        readonly store?: IdempotencyStore
        readonly ttlMs?: number
        readonly maxEntries?: number
      }
    | false
  /** Extra readiness checks for `/ready` (the database is always checked). */
  readonly readiness?: Readonly<Record<string, () => Promise<void>>>
  /** Override the database (default: `DatabaseToken`). */
  readonly database?: Database
  /** Override the model registry (default: `ModelRegistryToken`, else built from `resources`). */
  readonly registry?: ModelRegistry
  /** Custom routes (`route.get(…)`), mounted under `basePath` before the CRUD routes. */
  readonly routes?: readonly RouteDefinition[]
  /**
   * Serve a built single-page UI (e.g. `dist/web`) for requests no route matched: files from
   * `root`, and `index.html` for client-side routes. The API base path, `/_strutvane`,
   * `/storage` and the discovery documents are always excluded (an unknown API path stays a
   * problem+json 404).
   */
  readonly staticFiles?: StaticFilesOptions
  /**
   * Development: mark a not-found `GET`/`HEAD` outside the API and framework paths (the rule in
   * `ui-paths.ts`) with an internal header, so the Node adapter (`serve({ fallback })`) can hand it
   * to the project's Vite middleware. The response is still the problem+json 404, sent as is when
   * nothing else answers; the adapter strips the marker. Such requests are not reported to
   * `http.onResponse` (the dev server answers them, not the app). Default `false`.
   */
  readonly uiFallthrough?: boolean
}

/**
 * The hook payloads live in the contracts (`@strutvane/framework/contracts`, `http-hooks.ts`) so the framework and the
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
  const env = firstAppEnv(options.env, processAppEnv()) ?? 'production'
  const basePath = (options.basePath ?? '/api/v1').replace(/\/+$/, '')
  // Validated before anything else is built, so a bad value fails at boot, not per request.
  const appTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const timeout = requestTimeout(appTimeoutMs)
  const routeTimeouts = (options.routes ?? [])
    .filter(
      (r) =>
        r.timeoutMs !== undefined ||
        (r.bodyLimit !== undefined && r.bodyLimit > (options.bodyLimit ?? DEFAULT_BODY_LIMIT)),
    )
    .map((r) => ({
      method: r.method.toUpperCase(),
      pattern: routePattern(basePath, r.path),
      timeout: requestTimeout(
        r.timeoutMs ?? (appTimeoutMs === 0 ? 0 : Math.max(appTimeoutMs, UPLOAD_REQUEST_TIMEOUT_MS)),
      ),
    }))
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
  // Every form of trustProxy (a hop count, or a list of proxy addresses and ranges), checked at
  // boot: a bad entry throws a SecuritySettingError listing it.
  const proxies = resolveTrustProxy(options.trustProxy)
  const peerOf = (c: Context): string | undefined => peerAddress(c.env)
  const viaTrustedProxy = (c: Context): boolean => isTrustedProxy(peerOf(c), proxies)
  const publicUrl = parsePublicUrl(options.publicUrl)
  const openapiMode =
    options.openapi === false
      ? false
      : options.openapi === 'public' || options.openapi === 'authenticated'
        ? options.openapi
        : env === 'local'
          ? 'public'
          : 'authenticated'

  const hosts = resolveTrustedHosts({ publicUrl, hosts: options.trustedHosts })
  const http = new OpenAPIHono<HttpEnv>()

  const isHttps = (c: Context): boolean =>
    publicUrl?.protocol === 'https:' || forwardedClient(peerOf(c), c.req.raw, proxies).secure
  // One source for the session cookie's name (CONSISTENCY #105): the session layer reads it from
  // the container, the CSRF check below uses the same value. A binding that already exists (a
  // second HTTP app on the same application) wins, so the two can never disagree.
  const sessionCookie = app.container.has(SessionCookieToken)
    ? app.make(SessionCookieToken)
    : sessionCookieName({
        ...(options.session?.cookie !== undefined ? { base: options.session.cookie } : {}),
        secure: publicUrl?.protocol === 'https:',
      })
  if (!app.container.has(SessionCookieToken)) app.container.value(SessionCookieToken, sessionCookie)
  const csrf =
    options.csrf === false
      ? undefined
      : resolveCsrf(options.csrf ?? {}, {
          appKey: options.appKey ?? process.env['APP_KEY'],
          publicUrl,
          cookie: sessionCookie,
        })
  if (csrf === undefined)
    logger.warn('CSRF protection is off (csrf: false): cookie-authenticated writes are unchecked')

  // HSTS only in production (a local https:// dev server must not pin the browser to HTTPS).
  http.use('*', securityHeaders({ isHttps, environment: env }))
  // First after the headers: an unknown host never reaches a hook, a route or the dev UI.
  http.use('*', trustedHostsGuard(hosts, viaTrustedProxy))
  // Before the request hooks, so a hook that never settles is bounded too.
  http.use('*', (c, next) => {
    if (routeTimeouts.length === 0) return timeout(c, next)
    // The router's own decoding: `/sl%6Fw` is the `/slow` route and gets its timeout.
    const path = routerPath(c.req.raw)
    const own = routeTimeouts.find((r) => r.method === c.req.method && r.pattern.test(path))
    return (own?.timeout ?? timeout)(c, next)
  })
  // Before the request hooks, so routes a hook answers itself (sign-in, sign-out) are covered.
  if (csrf !== undefined) {
    http.use(
      '*',
      csrfProtection(csrf, {
        isHttps,
        // The origin the client used: the scheme it connected with and the Host it asked for.
        ownOrigin: (c) => exactOrigin(`${isHttps(c) ? 'https' : 'http'}://${requestHost(c)}`),
      }),
    )
  }
  http.use('*', async (c, next) => {
    // A client-sent id is only believed from a trusted proxy (else ids could be forged).
    const requestId = acceptRequestId(c.req.header('x-request-id'), () => ids(), viaTrustedProxy(c))
    const locale = negotiateLocale(c.req.header('accept-language'), messages.locales())
    const clientAddress = resolveClientAddress(c.env, c.req.raw, proxies)
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
    const route = matchedRouteTemplate(c)
    const done: HttpResponseHookPayload = {
      request: c.req.raw,
      status: c.res.status,
      requestId,
      ...(route !== undefined ? { route } : {}),
    }
    // A dev UI request (handed to Vite by the adapter) is not the app's response to report.
    if (!c.res.headers.has(UI_FALLTHROUGH_HEADER)) await hooks.run(HTTP_HOOKS.response, done)
    return undefined
  })
  const tooLarge = () => {
    throw new StrutvaneError('payload_too_large', { status: 413 })
  }
  const defaultLimit = bodyLimit({
    maxSize: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    onError: tooLarge,
  })
  // Custom routes may raise (or lower) the limit for themselves, e.g. an upload endpoint.
  const routeLimits = (options.routes ?? [])
    .filter((r) => r.bodyLimit !== undefined)
    .map((r) => ({
      method: r.method.toUpperCase(),
      pattern: routePattern(basePath, r.path),
      limit: bodyLimit({ maxSize: r.bodyLimit as number, onError: tooLarge }),
    }))
  http.use('*', (c, next) => {
    // Matched on the path the router serves (decoded), never the raw one: `/sm%61ll` reaches
    // the `/small` route and must get its limit, not the app-wide one.
    const path = routerPath(c.req.raw)
    const own = routeLimits.find((r) => r.method === c.req.method && r.pattern.test(path))
    return (own?.limit ?? defaultLimit)(c, next)
  })
  // After the hooks (keys are scoped to the actor and tenant) and the body limit (the body it
  // fingerprints is already bounded).
  if (options.idempotency !== false) {
    const settings = options.idempotency ?? {}
    const store = app.container.has(IdempotencyStoreToken)
      ? app.make(IdempotencyStoreToken)
      : (settings.store ??
        new MemoryIdempotencyStore({
          ...(settings.ttlMs !== undefined ? { ttlMs: settings.ttlMs } : {}),
          ...(settings.maxEntries !== undefined ? { maxEntries: settings.maxEntries } : {}),
        }))
    if (!app.container.has(IdempotencyStoreToken)) app.container.value(IdempotencyStoreToken, store)
    http.use(
      '*',
      idempotency({
        store,
        now: () => clock.now(),
        reads: resources.map((r) => routePattern(basePath, `/${r.definition.path}/query`)),
      }),
    )
  }

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
    app,
  }
  for (const files of options.signedFiles ?? []) {
    http.on(['GET', 'HEAD'], `${signedFilePrefix(files)}/*`, (c) =>
      serveSignedFile(c.req.raw, files),
    )
  }
  registerCustomRoutes(http, options.routes ?? [], {
    basePath,
    permissions,
    hooks,
    app,
    db,
    registry,
    ids: deps.ids,
    now: deps.now,
  })
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
    // The readable docs page: same document, same visibility rule, no scripts (docs-page.ts).
    http.get('/docs', (c) => {
      if (openapiMode === 'authenticated' && c.get('sv').actor === null)
        throw new UnauthenticatedError()
      return c.html(renderDocsPage(openApiDocument()), 200, {
        'Content-Security-Policy': DOCS_PAGE_CSP,
        'Cache-Control': 'no-store',
      })
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

  // One rule for what the UI may answer, shared by the built UI and the dev fallthrough.
  const uiExclude = uiExcludedPaths(basePath, options.staticFiles?.exclude ?? [])
  const staticFiles = options.staticFiles
    ? createStaticFiles({ ...options.staticFiles, exclude: uiExclude })
    : undefined

  http.notFound(async (c) => {
    const served = staticFiles ? await staticFiles(c.req.raw) : undefined
    if (served) return served
    const s = c.get('sv')
    const problem = toProblemBody(new StrutvaneError('not_found', { status: 404 }), {
      messages,
      registry: errors,
      locale: s?.locale ?? 'en',
      traceId: s?.requestId ?? ids(),
      instance: new URL(c.req.url).pathname,
    })
    const response = problemResponse(problem)
    // `sv dev`: the adapter hands this request to Vite instead (and sends this 404 if Vite
    // passes). Only UI requests are marked: API paths keep their problem+json 404.
    if (options.uiFallthrough === true && isUiRequest(c.req.raw, uiExclude))
      response.headers.set(UI_FALLTHROUGH_HEADER, '1')
    return response
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

/** The host the client asked for: the `Host` header, else the request URL's host. */
function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host
}

/**
 * The route template that handled the request (`/api/v1/invoices/:id`), for `http.onResponse`:
 * the last matched route registered for a method (middleware is registered for `ALL`).
 * `undefined` for unmatched requests (404s), so loggers never get an attacker-chosen path here.
 */
function matchedRouteTemplate(c: Context): string | undefined {
  const routes = matchedRoutes(c)
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i]
    if (r && r.method !== 'ALL') return r.path
  }
  return undefined
}

/**
 * The client address for this request. An adapter that already resolved it (this package's
 * `serve`, which applies `trustProxy` itself) passes `clientAddress`; otherwise the socket peer
 * from `@hono/node-server`'s `incoming` is used, with the trusted proxies' `X-Forwarded-For`
 * applied. Never read from headers alone.
 */
function resolveClientAddress(
  env: HttpBindings | undefined,
  request: Request,
  proxies: ResolvedProxies,
): string | undefined {
  if (env !== undefined && typeof env === 'object' && 'clientAddress' in env)
    return typeof env.clientAddress === 'string' ? env.clientAddress : undefined
  return forwardedClient(peerAddress(env), request, proxies).ip
}

/** The TCP peer: this package's `serve` passes `ip`; `@hono/node-server` passes `incoming`. */
function peerAddress(env: HttpBindings | undefined): string | undefined {
  if (env === undefined || typeof env !== 'object') return undefined
  return env.ip ?? env.incoming?.socket?.remoteAddress
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
