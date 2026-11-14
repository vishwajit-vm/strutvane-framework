/**
 * Boot a loaded project: create the core application with the project's providers and config,
 * hand the discovered models to the framework provider, and build the HTTP app.
 *
 * @module
 */
import { type Application, createApp } from '@strutvane/core'
import { createHttpApp, type HttpApp } from '../http/create-http-app.ts'
import type { TrustProxy } from '../http/proxy.ts'
import type { ResourceConfig } from '../http/resource.ts'
import type { AnyModel } from '../model/define-model.ts'
import { ProjectModelsToken } from '../tokens.ts'
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

/** Boot a loaded project. Shuts the app down again if building the HTTP app fails. */
export async function bootProject(
  project: LoadedProject,
  options: { readonly env?: string } = {},
): Promise<BootedProject> {
  const appConfig = project.config['app'] as
    | { env?: string; name?: string; publicUrl?: string; trustProxy?: TrustProxy }
    | undefined
  // Trimmed, lowercased, empty = unset; the CLI's guard reads APP_ENV the same way.
  const env = firstAppEnv(options.env, appConfig?.env, processAppEnv()) ?? 'production'
  const app = createApp({ config: project.config, providers: project.providers })
  app.container.value(ProjectModelsToken, project.models)
  await app.boot()
  try {
    const api = project.config['api'] as ApiConfig | undefined
    const http = createHttpApp(app, {
      resources: mergeResources(project.models, project.resources),
      routes: project.routes,
      basePath: apiBasePath(api),
      env,
      openapi: api?.docs !== false,
      info: { title: appConfig?.name ?? 'Strutvane API', version: '1.0.0' },
      ...(appConfig?.publicUrl ? { publicUrl: appConfig.publicUrl } : {}),
      ...(appConfig?.trustProxy !== undefined ? { trustProxy: appConfig.trustProxy } : {}),
    })
    return { app, http, env, shutdown: async () => void (await app.shutdown()) }
  } catch (error) {
    await app.shutdown()
    throw error
  }
}
