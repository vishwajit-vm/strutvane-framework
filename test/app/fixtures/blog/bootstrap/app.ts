/**
 * The fixture app's bootstrap/app.ts, with its config file and routes files inlined.
 *
 * It does not fill in the registries (RouteRegistry, ConfigRegistry, UserRegistry): this
 * repository compiles with `isolatedDeclarations`, which can't infer `typeof web` for an
 * augmentation, so the typed registries are proven in a separate compile
 * (test/routing/registry-typecheck.test.ts) whose tsconfig, like an app's, doesn't set it.
 */
import { dirname } from 'node:path'
import { Application } from '../../../../../src/foundation/application.ts'
import { type ConfigFiles, defineConfig } from '../../../../../src/foundation/config.ts'
import { APP_ENVIRONMENTS, type EnvSource } from '../../../../../src/foundation/env.ts'
import { defineRoutes, Route } from '../../../../../src/routing/route.ts'
import { AuthorController } from '../app/http/controllers/author.controller.ts'
import { DiagnosticsController } from '../app/http/controllers/diagnostics.controller.ts'
import { PingController } from '../app/http/controllers/ping.controller.ts'
import { PostController } from '../app/http/controllers/post.controller.ts'
import { SpaController } from '../app/http/controllers/spa.controller.ts'
import { StatsController } from '../app/http/controllers/stats.controller.ts'
import { EnsureAdmin } from '../app/http/middleware/ensure-admin.ts'
import { Author } from '../app/models/author.ts'
import { Post } from '../app/models/post.ts'
import { AppServiceProvider } from '../app/providers/app.provider.ts'

/** config/app.ts: every value typed and validated from the environment. */
const app = defineConfig((env) => ({
  name: env.string('APP_NAME', 'Strutvane Blog'),
  env: env.oneOf('APP_ENV', APP_ENVIRONMENTS, 'production'),
  debug: env.boolean('APP_DEBUG', false),
  url: env.url('APP_URL', 'http://localhost'),
  key: env.string('APP_KEY'),
  previous_keys: env.string('APP_PREVIOUS_KEYS', ''),
  per_page: env.integer('BLOG_PER_PAGE', 15),
  editor: env.optional('BLOG_EDITOR'),
}))

/** config/index.ts. */
const config: ConfigFiles = { app }

/** The config files, for tests that build their own app around them. */
export const blogConfig: ConfigFiles = config

/** routes/web.ts: a callback that returns its routes, so their names stay typed. */
const web = defineRoutes((router) => [
  router.get('/', [SpaController, 'show']).name('home'),
  router.get('/posts/{post:slug}', [SpaController, 'show']).name('posts.page'),
  router.get('/_diagnostics/boom', [DiagnosticsController, 'boom']).name('diagnostics.boom'),
  router.fallback([SpaController, 'show']),
])

/** routes/api.ts: under /api with the api group (CSRF + throttle:api). */
const api = defineRoutes([
  Route.apiResource('posts', PostController, { bindBy: 'slug' }).middlewareFor(
    ['store', 'update', 'destroy'],
    'auth',
  ),
  Route.post('/posts/{post:slug}/publish', [PostController, 'publish'])
    .name('posts.publish')
    .middleware('auth'),
  Route.apiResource('authors', AuthorController, {
    only: ['index', 'show', 'store'],
  }).middlewareFor(['store'], 'auth'),
  Route.get('/me', (ctx) => ctx.json({ data: ctx.requireUser() }))
    .name('me')
    .middleware('auth'),
  Route.get('/ping', PingController).name('ping'),
  Route.group({ prefix: 'admin', name: 'admin.', middleware: ['auth', 'admin'] }, [
    Route.get('/stats', [StatsController, 'show']).name('stats'),
  ]),
])

/** Build the fixture app, Laravel's bootstrap/app.php. Tests pass their own environment. */
export function createBlogApp(env?: EnvSource): Application {
  return Application.configure({
    basePath: dirname(import.meta.dirname),
    ...(env === undefined ? {} : { env }),
  })
    .withConfig(config)
    .withProviders([AppServiceProvider])
    .withRouting({ web, api, bindings: { post: Post, author: Author } })
    .withMiddleware((m) => {
      m.alias({ admin: EnsureAdmin })
      m.rateLimiter('api', { maxAttempts: 120, decaySeconds: 60 })
    })
    .create()
}

/** What `node strut` loads. */
const application: Application = createBlogApp()
export default application
