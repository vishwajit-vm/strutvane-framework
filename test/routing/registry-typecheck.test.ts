/**
 * The filled-in registries, proven the way an app uses them: a small app (routes files, a config
 * file, a user type and the one `declare module` block) is written to a temporary folder and
 * compiled by `tsc` with an app-style tsconfig. The compile must succeed, and every
 * `@ts-expect-error` in it must be a real error (an unused one fails the compile), so:
 *
 * - augmenting the registries **through a re-export** (`./framework.ts` stands in for
 *   `@strutvane/framework`) reaches the declaring module;
 * - `route()`, `url.signedRoute()` and `config()` are checked against the app's own files;
 * - `ctx.user` is the app's user type.
 *
 * Why a separate compile: this repository sets `isolatedDeclarations`, which can't infer
 * `typeof web` for an augmentation. Apps don't set it (it is for publishing libraries), and the
 * generated app tsconfig must not either.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..', '..')
const folder = mkdtempSync(join(tmpdir(), 'strut-typed-app-'))
afterAll(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }))

/** An import path from the temporary app to a framework source file. */
const src = (path: string): string =>
  relative(folder, join(ROOT, 'src', path))
    .split('\\')
    .join('/')

const FILES: Record<string, string> = {
  'framework.ts': `export type { AuthUser, ConfigRegistry, RouteRegistry, UserRegistry } from '${src('foundation/registry.ts')}'\n`,
  'app.ts': `
import { defineConfig, type ConfigOf } from '${src('foundation/config.ts')}'
import type { HttpContext } from '${src('http/app/context.ts')}'
import { defineRoutes, Route } from '${src('routing/route.ts')}'
import type { RoutesOf } from '${src('routing/types.ts')}'

export interface User { readonly id: string; readonly type: 'user'; readonly roles: readonly string[]; readonly attrs: Readonly<Record<string, unknown>>; readonly isAdmin: boolean }

class PostController {
  index(ctx: HttpContext): Response { return ctx.json([]) }
  store(ctx: HttpContext): Response { return ctx.json({}) }
  show(ctx: HttpContext): Response { return ctx.json({}) }
  update(ctx: HttpContext): Response { return ctx.json({}) }
  destroy(ctx: HttpContext): Response { return ctx.json({}) }
}

export const web = defineRoutes((router) => [
  router.get('/', (ctx) => ctx.json({})).name('home'),
  router.get('/files/{file}', (ctx) => ctx.json({})).name('files.show').middleware('signed'),
])
export const api = defineRoutes([
  Route.apiResource('posts', PostController, { bindBy: 'slug' }),
  Route.group({ prefix: 'admin', name: 'admin.' }, [Route.get('/stats', (ctx) => ctx.json({})).name('stats')]),
])
export const config = {
  app: defineConfig((env) => ({ name: env.string('APP_NAME', 'Typed'), debug: env.boolean('APP_DEBUG', false), env: env.oneOf('APP_ENV', ['local', 'testing', 'staging', 'production']) })),
}

declare module './framework.ts' {
  interface RouteRegistry extends RoutesOf<[typeof web, typeof api]> {}
  interface UserRegistry { user: User }
}
declare module '${src('foundation/registry.ts')}' {
  interface ConfigRegistry extends ConfigOf<typeof config> {}
}
`,
  'checks.ts': `
import { config } from '${src('foundation/helpers.ts')}'
import type { HttpContext } from '${src('http/app/context.ts')}'
import { route } from '${src('routing/route-helper.ts')}'
import { url } from '${src('routing/url.ts')}'
import type { User } from './app.ts'

export function checks(ctx: HttpContext): void {
  route('home')
  route('posts.show', { post: 'hello' })
  route('posts.index', {}, { query: { page: 2 } })
  route('admin.stats')
  // @ts-expect-error: no route has this name (typo)
  route('posts.shwo', { post: 'hello' })
  // @ts-expect-error: posts.show needs {post}
  route('posts.show', {})
  // @ts-expect-error: the params object is required when the path has parameters
  route('posts.show')
  // @ts-expect-error: a boolean can't fill a URL parameter
  route('posts.show', { post: true })
  url.signedRoute('files.show', { file: 7 }, { expiresIn: 60 })
  url.temporarySignedRoute('files.show', new Date(), { file: 7 })
  // @ts-expect-error: signed links are typed like route()
  url.signedRoute('files.shwo', { file: 7 })
  const debug: boolean = config('app.debug')
  const environment: 'local' | 'testing' | 'staging' | 'production' = config('app.env')
  // @ts-expect-error: no such config key
  config('app.nmae')
  // @ts-expect-error: app.name is a string, not a number
  const wrong: number = config('app.name')
  const user: User | null = ctx.user
  const admin: boolean | undefined = ctx.user?.isAdmin
  void [debug, environment, wrong, user, admin]
}
`,
  'tsconfig.json': JSON.stringify(
    {
      extends: join(ROOT, 'tsconfig.base.json').split('\\').join('/'),
      compilerOptions: {
        isolatedDeclarations: false,
        declaration: false,
        declarationMap: false,
        lib: ['ES2024', 'DOM', 'DOM.Iterable'],
        types: ['node'],
        typeRoots: [join(ROOT, 'node_modules', '@types').split('\\').join('/')],
      },
      files: ['framework.ts', 'app.ts', 'checks.ts'],
    },
    null,
    2,
  ),
  'package.json': '{ "type": "module" }\n',
}

describe('the registries an app fills in (separate tsc compile)', () => {
  it('type-check route names, parameters, config keys and the user, augmented through a re-export', () => {
    for (const [name, content] of Object.entries(FILES)) writeFileSync(join(folder, name), content)
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const result = spawnSync(
      process.execPath,
      [tsc, '-p', join(folder, 'tsconfig.json'), '--pretty', 'false'],
      {
        cwd: folder,
        encoding: 'utf8',
        timeout: 280_000,
      },
    )
    expect(`${result.stdout}${result.stderr}`).toBe('')
    expect(result.status).toBe(0)
  }, 300_000)
})

/**
 * The same block written the way a real app writes it: **everything** imported from the package
 * entry (`./framework.ts` re-exports `src/index.ts`, standing in for `@strutvane/framework`), and
 * all three registries augmented there. 0.2.0-next.0 didn't export `ConfigOf` or `RoutesOf`, so an
 * app could not write the block `foundation/registry.ts` documents (found by the skeleton).
 */
const PUBLIC = mkdtempSync(join(tmpdir(), 'strut-public-app-'))
afterAll(() => rmSync(PUBLIC, { recursive: true, force: true, maxRetries: 5 }))
const entry = relative(PUBLIC, join(ROOT, 'src', 'index.ts'))
  .split('\\')
  .join('/')

const PUBLIC_FILES: Record<string, string> = {
  'framework.ts': `export * from '${entry}'\n`,
  'app.ts': `
import { type ConfigOf, config, defineConfig, defineRoutes, type HttpContext, Route, type RoutesOf, route } from './framework.ts'

export interface Member { readonly id: string; readonly type: 'user'; readonly roles: readonly string[]; readonly attrs: Readonly<Record<string, unknown>>; readonly team: string }

export const web = defineRoutes([Route.get('/', (ctx) => ctx.json({})).name('home')])
export const api = defineRoutes([Route.get('/posts/{post}', (ctx) => ctx.json({})).name('posts.show')])
export const settings = {
  app: defineConfig((env) => ({ name: env.string('APP_NAME', 'Typed'), debug: env.boolean('APP_DEBUG', false) })),
}

declare module './framework.ts' {
  interface RouteRegistry extends RoutesOf<[typeof web, typeof api]> {}
  interface ConfigRegistry extends ConfigOf<typeof settings> {}
  interface UserRegistry { user: Member }
}

export function checks(ctx: HttpContext): void {
  route('home')
  route('posts.show', { post: 'hello' })
  // @ts-expect-error: no route has this name
  route('posts.shwo', { post: 'hello' })
  const debug: boolean = config('app.debug')
  // @ts-expect-error: no such config key
  config('app.nmae')
  const team: string | undefined = ctx.user?.team
  void [debug, team]
}
`,
  'tsconfig.json':
    FILES['tsconfig.json']?.replace(
      '"files": [\n    "framework.ts",\n    "app.ts",\n    "checks.ts"\n  ]',
      '"files": [\n    "framework.ts",\n    "app.ts"\n  ]',
    ) ?? '',
  'package.json': '{ "type": "module" }\n',
}

describe('the registries, through the public entry only', () => {
  it('ConfigOf, RoutesOf and the registries are exported, and augmenting the entry types route() and config()', () => {
    expect(PUBLIC_FILES['tsconfig.json']).toContain('"app.ts"\n  ]')
    for (const [name, content] of Object.entries(PUBLIC_FILES))
      writeFileSync(join(PUBLIC, name), content)
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    const result = spawnSync(
      process.execPath,
      [tsc, '-p', join(PUBLIC, 'tsconfig.json'), '--pretty', 'false'],
      { cwd: PUBLIC, encoding: 'utf8', timeout: 280_000 },
    )
    expect(`${result.stdout}${result.stderr}`).toBe('')
    expect(result.status).toBe(0)
  }, 300_000)
})
