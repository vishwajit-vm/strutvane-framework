/**
 * Shared setup for the application-core tests: the blog fixture with a seeded in-memory database,
 * a test clock and a memory logger, plus `customApp()` for testing one protection in isolation.
 */
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { LogFields, Logger, LogLevel } from '../../src/contracts/logger.ts'
import { createTestClock, type TestClock } from '../../src/core/clock.ts'
import { ClockToken, LoggerToken } from '../../src/core/tokens.ts'
import { Application, type RoutingOptions } from '../../src/foundation/application.ts'
import type { MiddlewareConfig } from '../../src/http/app/middleware.ts'
import { type TestClient, testClient } from '../../src/testing/app-client.ts'
import { Author } from './fixtures/blog/app/models/author.ts'
import { Post } from './fixtures/blog/app/models/post.ts'
import { BlogDb, BlogDbToken } from './fixtures/blog/app/models/store.ts'
import { AppServiceProvider } from './fixtures/blog/app/providers/app.provider.ts'
import { blogConfig, createBlogApp } from './fixtures/blog/bootstrap/app.ts'

/** A generated 32-byte key (CONSISTENCY #79: never `dev` or `testing-key`). */
export const APP_KEY: string = `base64:${randomBytes(32).toString('base64')}`

/** The environment every test app gets: deterministic, nothing read from the real env. */
export const testEnv: Readonly<Record<string, string>> = Object.freeze({
  APP_NAME: 'Blog Test',
  APP_ENV: 'testing',
  APP_DEBUG: 'true',
  APP_URL: 'http://localhost',
  APP_KEY,
})

/** The fixture app's folder. */
export const BLOG_BASE: string = join(import.meta.dirname, 'fixtures', 'blog')

/** The fixed start time of every test clock. */
export const NOW: number = Date.UTC(2026, 10, 14, 10, 0, 0)

/** One log entry. */
export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly fields: LogFields | undefined
}

/** A logger that keeps every entry, for assertions. */
export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = []

  trace(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'trace', message, fields })
  }
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'debug', message, fields })
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'info', message, fields })
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'warn', message, fields })
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'error', message, fields })
  }
  fatal(message: string, fields?: LogFields): void {
    this.entries.push({ level: 'fatal', message, fields })
  }
  child(): Logger {
    return this
  }
  isLevelEnabled(): boolean {
    return true
  }
  async flush(): Promise<void> {}
  messages(level: LogLevel): string[] {
    return this.entries.filter((entry) => entry.level === level).map((entry) => entry.message)
  }
}

/** The seeded API tokens, by author. */
export const tokens: { readonly admin: string; readonly alice: string; readonly bob: string } = {
  admin: 'token-ada',
  alice: 'token-alice',
  bob: 'token-bob',
}

/** Seed: Ada (admin), Alice, Bob; posts hello-world, routing (Alice, published), alice-draft (Alice, draft), bob-on-policies (Bob, published), admin-notes (Ada, draft). */
export function seed(database: BlogDb): void {
  database.insert('authors', {
    name: 'Ada Admin',
    email: 'ada@example.test',
    bio: null,
    is_admin: true,
    api_token: tokens.admin,
  })
  database.insert('authors', {
    name: 'Alice Writer',
    email: 'alice@example.test',
    bio: null,
    is_admin: false,
    api_token: tokens.alice,
  })
  database.insert('authors', {
    name: 'Bob Reader',
    email: 'bob@example.test',
    bio: null,
    is_admin: false,
    api_token: tokens.bob,
  })
  const post = (
    slug: string,
    title: string,
    author: number,
    status: 'draft' | 'published',
  ): void => {
    database.insert('posts', {
      slug,
      title,
      body: `${title} body`,
      status,
      author_id: author,
      published_at: null,
      deleted_at: null,
    })
  }
  post('hello-world', 'Hello World', 2, 'published')
  post('routing', 'Routing like Laravel', 2, 'published')
  post('alice-draft', 'Alice draft', 2, 'draft')
  post('bob-on-policies', 'Bob on policies', 3, 'published')
  post('admin-notes', 'Admin notes', 1, 'draft')
}

/** What a test gets: the app, its logger and clock, and a client. */
export interface TestApp {
  readonly app: Application
  readonly logger: MemoryLogger
  readonly clock: TestClock
  readonly db: BlogDb
  readonly client: TestClient
}

function prepare(app: Application): TestApp {
  const logger = new MemoryLogger()
  const clock = createTestClock(NOW)
  const database = new BlogDb()
  seed(database)
  // Bound before boot, so the core keeps them instead of its defaults.
  app.container.value(LoggerToken, logger)
  app.container.value(ClockToken, clock)
  app.container.value(BlogDbToken, database)
  return { app, logger, clock, db: database, client: testClient(app) }
}

/**
 * The blog fixture, seeded.
 *
 * @example
 * const { app, client } = await blogApp()
 */
export async function blogApp(
  env: Readonly<Record<string, string>> = {},
  options: { readonly forceDebug?: boolean } = {},
): Promise<TestApp> {
  const app = createBlogApp({ ...testEnv, ...env })
  if (options.forceDebug === true) app.forceDebug()
  const prepared = prepare(app)
  await app.boot()
  return prepared
}

/**
 * An app with the fixture's config, provider and bindings, but your own routes and middleware.
 *
 * @example
 * const { client } = await customApp({ web: defineRoutes([Route.post('/x', handler)]) })
 */
export async function customApp(
  routing: RoutingOptions,
  configure: (middleware: MiddlewareConfig) => void = () => {},
  env: Readonly<Record<string, string>> = {},
  setup: (app: Application) => void = () => {},
): Promise<TestApp> {
  const app = Application.configure({ basePath: BLOG_BASE, env: { ...testEnv, ...env } })
    .withConfig(blogConfig)
    .withProviders([AppServiceProvider])
    .withRouting({ bindings: { post: Post, author: Author }, ...routing })
    .withMiddleware(configure)
    .create()
  setup(app)
  const prepared = prepare(app)
  await app.boot()
  return prepared
}

/** The author with this seeded id, for `actingAs()`. */
export function author(prepared: TestApp, id: 1 | 2 | 3): Author {
  const row = prepared.db.table('authors').rows.find((candidate) => candidate['id'] === id)
  if (row === undefined) throw new Error(`No author ${id}`)
  return new Author(row)
}

/** The folder a fixture path lives in (for copying the fixture). */
export const FIXTURES: string = dirname(BLOG_BASE)
