/**
 * The public entry points of the application core: what `@strutvane/framework` and
 * `@strutvane/framework/facades` export, the callable `route()` that still carries the v1
 * builders, and the application catalogs (every code an app can return renders with a title).
 */
import { describe, expect, it } from 'vitest'
import {
  createErrorRegistry,
  createMessages,
  StrutvaneError,
  toProblem,
} from '../../src/core/index.ts'
import * as httpEntry from '../../src/entries/http.ts'
import * as facades from '../../src/facades/index.ts'
import * as framework from '../../src/index.ts'
import {
  APPLICATION_ERRORS,
  applicationMessages,
  FRAMEWORK_ERRORS,
  registerApplicationErrors,
} from '../../src/messages.ts'

describe('@strutvane/framework', () => {
  it('exports the application core next to the v1 API', () => {
    for (const name of [
      'Application',
      'ApplicationBuilder',
      'BootError',
      'defineConfig',
      'defineRoutes',
      'Route',
      'route',
      'config',
      'app',
      'ExceptionHandler',
      'Keyring',
      'createCacheManager',
      'FileSessionStore',
      'FormRequest',
      'ResourceController',
      'csrf_field',
      // v1, still there
      'createHttpApp',
      'defineModel',
      'migrate',
    ])
      expect(framework, name).toHaveProperty(name)
  })

  it('route() builds URLs and keeps the deprecated v1 builders, from both entries', () => {
    expect(typeof framework.route).toBe('function')
    expect(httpEntry.route).toBe(framework.route)
    const definition = framework.route.get('/hello', { public: true, handler: () => ({}) })
    expect(definition).toMatchObject({ method: 'get', path: '/hello', public: true })
  })

  it('keeps the Route facade on its own subpath, so it never shadows the Route builder', () => {
    expect(facades.Route).not.toBe(framework.Route)
    expect(framework).not.toHaveProperty('Log')
    for (const name of ['Log', 'Cache', 'DB', 'Route', 'Storage', 'Http', 'Event', 'Crypt', 'Url'])
      expect(facades, name).toHaveProperty(name)
  })
})

describe('application catalogs', () => {
  it('registers every application code once, next to codes a package already registered', () => {
    const registry = createErrorRegistry()
    registry.register({ code: 'maintenance_mode', status: 503, title: 'Ours', owner: 'pkg' })
    registerApplicationErrors(registry)
    registerApplicationErrors(registry)
    expect(registry.get('maintenance_mode')?.owner).toBe('pkg')
    for (const { code } of [...FRAMEWORK_ERRORS, ...APPLICATION_ERRORS]) {
      expect(registry.get(code), code).toBeDefined()
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('renders maintenance and cache problems with catalog titles and details', () => {
    const registry = createErrorRegistry()
    registerApplicationErrors(registry)
    const messages = applicationMessages(createMessages())
    expect(toProblem(new StrutvaneError('maintenance_mode'), { registry, messages })).toMatchObject(
      {
        status: 503,
        title: 'Down for maintenance',
        detail: 'The application is down for maintenance. Please try again in a few minutes.',
      },
    )
    expect(
      toProblem(new StrutvaneError('cache_unavailable'), { registry, messages }),
    ).toMatchObject({ status: 503, title: 'Cache temporarily unavailable' })
    // The application's wording wins over the framework's for the same key.
    expect(messages.format('validation.unknown_field', { attribute: 'x' })).toContain(
      'Remove it from the request body',
    )
  })
})
