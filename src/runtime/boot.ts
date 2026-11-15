/**
 * Boot a loaded project: create the core application with the project's providers and config,
 * hand the discovered models to the framework provider, and build the HTTP app.
 *
 * @module
 */
import { type Application, createApp } from '../core/index.ts'
import { createHttpApp, type HttpApp } from '../http/create-http-app.ts'
import type { CsrfOptions } from '../http/csrf.ts'
import type { TrustProxy } from '../http/proxy.ts'
import type { ResourceConfig } from '../http/resource.ts'
import type { AnyModel } from '../model/define-model.ts'
import { ProjectModelsToken, ProjectSignedFilesToken } from '../tokens.ts'
import { firstAppEnv, processAppEnv } from './app-env.ts'
import type { LoadedProject } from './project.ts'

/** A booted project. */
export interface BootedProject {
  readonly app: Application
  readonly http: HttpApp
  /** `APP_ENV` the app runs under. */
  readonly env: string
  shutdown(): Promise<void>
}

/** API settings (`config/api.ts`). */
export interface ApiConfig {
  readonly prefix?: string
  readonly version?: string
  readonly docs?: boolean
}

/**
 * Session settings (`config/session.ts`) as far as the framework reads them: the cookie's base
 * name (one source for the session layer and the CSRF check) and the CSRF options.
 */
export interface SessionConfig {
  /** Base name of the session cookie. Default `strutvane_session` (`__Host-` added on https). */
  readonly cookie?: string
  /** CSRF exceptions and extra trusted origins; `false` turns CSRF off (not recommended). */
  readonly csrf?: CsrfOptions | false
}

/** `/api` + `v1` → `/api/v1`, tolerating missing or doubled slashes. */
export function apiBasePath(api: ApiConfig | undefined): string {
  const prefix = (api?.prefix ?? '/api').replace(/\/+$/, '')
  const version = (api?.version ?? 'v1').replace(/^\/+|\/+$/g, '')
  return `/${prefix}/${version}`.replace(/\/{2,}/g, '/')
}

/**
 * Every model gets its CRUD API; a resource file (`app/resources/*.resource.ts`) replaces the
 * default configuration for its model.
 */
export function mergeResources(
  models: readonly AnyModel[],
  resources: readonly ResourceConfig[],
): (ResourceConfig | AnyModel)[] {
  const byName = new Map<string, ResourceConfig>()
  for (const r of resources) {
    const name = 'definition' in r.model ? r.model.definition.name : r.model.name
    if (byName.has(name)) throw new Error(`Two resource files for model ${name}`)
    if (!models.some((m) => m.definition.name === name))
      throw new Error(`The resource for ${name} has no model in app/models`)
    byName.set(name, r)
  }
  return models.map((m) => byName.get(m.definition.name) ?? m)
}

/** Default upper bound for booting every provider ({@link bootProject} `bootTimeoutMs`). */
export const DEFAULT_BOOT_TIMEOUT_MS = 30_000

/**
 * A provider's `boot()` never settled (a connection that neither succeeds nor fails, a hook that
 * waits forever). Booting is abandoned and the providers that did boot are shut down, so
 * `sv start` reports this and exits instead of hanging silently.
 */
export class BootTimeoutError extends Error {
  override readonly name = 'BootTimeoutError'
  /** Stable code the CLI matches (never the message). */
  readonly code = 'BOOT_TIMEOUT'
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(
      `The app did not finish booting within ${timeoutMs} ms: a provider's boot() never settled (check database, cache or mail connections).`,
    )
    this.timeoutMs = timeoutMs
  }
}

/**
 * Boot a loaded project. When booting fails or times out, or building the HTTP app fails, the
 * app is shut down again, so the providers that did boot release their connections and timers
 * (otherwise the process could not exit after reporting the error).
 */
export async function bootProject(
  project: LoadedProject,
  options: {
    readonly env?: string
    /** Serve this built UI folder (e.g. `dist/web`) next to the API (`sv start`). */
    readonly web?: string
    /** Let unmatched UI requests fall through to the dev server (`sv dev` with Vite). */
    readonly uiFallthrough?: boolean
    /** Upper bound for booting every provider. Default {@link DEFAULT_BOOT_TIMEOUT_MS}. */
    readonly bootTimeoutMs?: number
  } = {},
): Promise<BootedProject> {
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  if (!Number.isFinite(bootTimeoutMs) || bootTimeoutMs <= 0)
    throw new RangeError('bootTimeoutMs must be a positive number')
  const appConfig = project.config['app'] as
    | {
        env?: string
        name?: string
        key?: string
        publicUrl?: string
        trustProxy?: TrustProxy
        trustedHosts?: readonly string[]
      }
    | undefined
  const session = project.config['session'] as SessionConfig | undefined
  // Trimmed, lowercased, empty = unset; the CLI's guard reads APP_ENV the same way.
  const env = firstAppEnv(options.env, appConfig?.env, processAppEnv()) ?? 'production'
  const app = createApp({ config: project.config, providers: project.providers })
  app.container.value(ProjectModelsToken, project.models)
  // One guarded block (kernel and resilience audits both fixed this): a failed or timed-out boot,
  // or a failure building the HTTP app, shuts down whatever providers did boot.
  try {
    await withDeadline(app.boot(), bootTimeoutMs)
    const api = project.config['api'] as ApiConfig | undefined
    const http = createHttpApp(app, {
      resources: mergeResources(project.models, project.resources),
      routes: project.routes,
      signedFiles: app.container.has(ProjectSignedFilesToken)
        ? app.make(ProjectSignedFilesToken)
        : [],
      ...(options.web ? { staticFiles: { root: options.web } } : {}),
      ...(options.uiFallthrough === true ? { uiFallthrough: true } : {}),
      basePath: apiBasePath(api),
      env,
      openapi: api?.docs !== false,
      info: { title: appConfig?.name ?? 'Strutvane API', version: '1.0.0' },
      ...(appConfig?.publicUrl ? { publicUrl: appConfig.publicUrl } : {}),
      ...(appConfig?.trustProxy !== undefined ? { trustProxy: appConfig.trustProxy } : {}),
      ...(appConfig?.key ? { appKey: appConfig.key } : {}),
      ...(appConfig?.trustedHosts ? { trustedHosts: appConfig.trustedHosts } : {}),
      ...(session?.cookie !== undefined ? { session: { cookie: session.cookie } } : {}),
      ...(session?.csrf !== undefined ? { csrf: session.csrf } : {}),
    })
    return { app, http, env, shutdown: async () => void (await app.shutdown()) }
  } catch (error) {
    await app.shutdown()
    throw error
  }
}

/** Settle like `work`, or reject with {@link BootTimeoutError} after `ms`. */
async function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BootTimeoutError(ms)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
