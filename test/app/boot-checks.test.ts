/**
 * Start-up checks from the security review: route mistakes fail at boot, not at the first request
 * (F-01 internal tables never get an auto resource, F-11 resource routes need a policy, missing
 * bindings and actions), plus `withExceptions` and the ResourceController's deny-by-default and
 * mass-assignment edges.
 */
import { describe, expect, it } from 'vitest'
import { PolicyRegistryToken } from '../../src/auth/policies.ts'
import { LoggerToken } from '../../src/core/tokens.ts'
import { Application } from '../../src/foundation/application.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import type { HttpContext } from '../../src/http/app/context.ts'
import { ResponseError } from '../../src/http/app/errors.ts'
import { ResourceController } from '../../src/http/app/resource-controller.ts'
import type { ResourceMetadata } from '../../src/http/app/resource-model.ts'
import { isInternalResource } from '../../src/http/app/resource-model.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { FormRequest, type StandardSchema } from '../../src/validation/form-request.ts'
import { Author } from './fixtures/blog/app/models/author.ts'
import { Post } from './fixtures/blog/app/models/post.ts'
import { blogConfig } from './fixtures/blog/bootstrap/app.ts'
import { author, BLOG_BASE, customApp, MemoryLogger, testEnv } from './helpers.ts'

const ok = (ctx: HttpContext): Response => ctx.json({})

async function bootError(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; hint: string }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  if (isBootError(error)) return error
  throw new Error(`Expected a boot error, got ${String(error)}`)
}

/** A post model whose table is flagged internal. */
class SecretPost extends Post {
  static override metadata(): ResourceMetadata {
    return { ...Post.metadata(), table: 'sessions', model: 'SecretPost' }
  }
}

class SecretController extends ResourceController<typeof SecretPost> {
  protected readonly model: typeof SecretPost = SecretPost
}

/** A model with no policy file in app/policies. */
class Orphan extends Post {}

class OrphanController extends ResourceController<typeof Orphan> {
  protected readonly model: typeof Orphan = Orphan
}

describe('F-01 and F-11: start-up checks', () => {
  it('refuses at boot to serve an internal table, flagged or by name', async () => {
    const error = await bootError(
      customApp({
        api: defineRoutes([Route.apiResource('posts', SecretController, { only: ['index'] })]),
      }),
    )
    expect(error.code).toBe('internal_table_exposed')
    for (const table of [
      'sessions',
      'personal_access_tokens',
      'user_roles',
      'failed_jobs',
      'users',
      'team_invitations',
      'team_whatever',
      'audit_events',
      'migrations',
    ])
      expect(isInternalResource({ ...Post.metadata(), table }), table).toBe(true)
    expect(isInternalResource({ ...Post.metadata(), internal: true })).toBe(true)
    expect(isInternalResource(Post.metadata())).toBe(false)
  })

  it('refuses resource routes whose plain controller has no policy', async () => {
    class LooseController {
      index(ctx: HttpContext): Response {
        return ctx.json([])
      }
      show(ctx: HttpContext): Response {
        return ctx.json({})
      }
    }
    expect(
      (
        await bootError(
          customApp({
            api: defineRoutes([
              Route.apiResource('things', LooseController, { only: ['index', 'show'] }),
            ]),
          }),
        )
      ).code,
    ).toBe('resource_without_policy')
  })

  it('refuses a ResourceController whose model has no policy (deny by default would hide every action)', async () => {
    const error = await bootError(
      customApp({
        api: defineRoutes([Route.apiResource('orphans', OrphanController, { only: ['index'] })]),
      }),
    )
    expect(error.code).toBe('missing_policy')
    expect(error.hint).toContain('app/policies/orphan.policy.ts')
  })

  it('refuses {param:field} without a binding, an unbound parent parameter and a missing action', async () => {
    expect(
      (await bootError(customApp({ web: defineRoutes([Route.get('/things/{thing:slug}', ok)]) })))
        .hint,
    ).toBe('Add it in bootstrap/app.ts: withRouting({ bindings: { thing: YourModel } }).')
    class PostsController extends ResourceController<typeof Post> {
      protected readonly model: typeof Post = Post
    }
    expect(
      (
        await bootError(
          customApp({
            api: defineRoutes([
              Route.apiResource('shops.articles', PostsController, { only: ['show'] }),
            ]),
          }),
        )
      ).code,
    ).toBe('missing_binding')
    // The resource's own parameter is bound implicitly to the controller's model (FW-5); only a
    // parent ({shop}) needs an explicit binding.
    await expect(
      customApp({
        api: defineRoutes([Route.apiResource('articles', PostsController, { only: ['show'] })]),
      }),
    ).resolves.toBeDefined()
    class Partial {
      index(ctx: HttpContext): Response {
        return ctx.json([])
      }
    }
    expect(
      (
        await bootError(
          customApp({ web: defineRoutes([Route.get('/p', [Partial, 'missing' as never])]) }),
        )
      ).code,
    ).toBe('missing_action')
  })
})

describe('ResourceController edges', () => {
  it('denies everything when no policy exists at request time (discovery found none)', async () => {
    class LatePolicyController extends ResourceController<typeof Orphan> {
      protected readonly model: typeof Orphan = Orphan
    }
    const prepared = await customApp({}, () => {})
    const registry = prepared.app.make(PolicyRegistryToken)
    // Simulate a route cache that skipped the boot checks: the controller runs with no policy.
    const ctx = { user: null } as unknown as HttpContext
    await expect(
      prepared.app.run(() => new LatePolicyController().index(ctx)),
    ).rejects.toMatchObject({ status: 403 })
    expect(registry.for(Orphan)).toBeUndefined()
  })

  it('turns a unique-index race into a 409, and refuses validated keys outside fillable', async () => {
    class RacingPost extends Post {
      static override async createFromValidated(): Promise<Post> {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        })
      }
    }
    class Loose extends FormRequest<{ title: string; author_id: number }> {
      rules(): StandardSchema<{ title: string; author_id: number }> {
        return {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value) => ({ value: value as { title: string; author_id: number } }),
          },
        }
      }
    }
    class RacingController extends ResourceController<typeof RacingPost> {
      protected readonly model: typeof RacingPost = RacingPost
      protected override readonly policy = { create: () => true, viewAny: () => true }
      protected override readonly storeRequest: Loose | undefined = new Loose()
    }
    const prepared = await customApp({
      api: defineRoutes([Route.apiResource('racing-posts', RacingController, { only: ['store'] })]),
    })
    const alice = prepared.client.actingAs(author(prepared, 2))
    ;(await alice.postJson('/api/racing-posts', { title: 'Race' })).assertProblem(409, 'conflict')
    ;(await alice.postJson('/api/racing-posts', { title: 'Race', author_id: 1 }))
      .assertProblem(422, 'validation_failed')
      .assertJsonPath('issues.0.path', ['author_id'])
  })

  it('uses the metadata-derived request for update, with owner keys and timestamps server-only', async () => {
    class AuthorAdmin extends ResourceController<typeof Author> {
      protected readonly model: typeof Author = Author
      protected override readonly policy = { view: () => true, update: () => true }
    }
    const prepared = await customApp({
      api: defineRoutes([
        Route.apiResource('writers', AuthorAdmin, { only: ['update'], parameter: 'author' }),
      ]),
    })
    const alice = prepared.client.actingAs(author(prepared, 2))
    ;(await alice.patchJson('/api/writers/2', { bio: 'Hello' }))
      .assertStatus(200)
      .assertJsonPath('data.bio', 'Hello')
    ;(await alice.patchJson('/api/writers/2', { email: 'bob@example.test' }))
      .assertProblem(422, 'validation_failed')
      .assertJsonPath('issues.0.code', 'unique')
    ;(await alice.patchJson('/api/writers/2', { api_token: 'mine' })).assertProblem(
      422,
      'validation_failed',
    )
  })
})

describe('withExceptions and early responses', () => {
  it('renders, reports and skips errors as the app configured', async () => {
    class PaymentDeclined extends Error {}
    class Gone extends Error {}
    const reported: string[] = []
    const fail = (error: unknown) => (): Response => {
      throw error
    }
    const app = Application.configure({ basePath: BLOG_BASE, env: testEnv })
      .withConfig(blogConfig)
      .withRouting({
        web: defineRoutes([
          Route.get('/declined', fail(new PaymentDeclined('card declined'))),
          Route.get('/gone', fail(new Gone('gone'))),
          Route.get('/silent', fail(new Error('handled by a tracker'))),
          Route.get('/broken-reporter', fail(new Error('reported twice'))),
          Route.get(
            '/early',
            fail(
              new ResponseError(
                new Response(null, { status: 302, headers: { location: '/login' } }),
              ),
            ),
          ),
          Route.get('/value', fail('a string, not an error')),
        ]),
      })
      .withExceptions((e) =>
        e
          .dontReport(PaymentDeclined)
          .report((error) => {
            if (error instanceof Error && error.message === 'reported twice')
              throw new Error('tracker down')
            reported.push(error instanceof Error ? error.message : String(error))
            return error instanceof Error && error.message === 'handled by a tracker'
              ? false
              : undefined
          })
          .render((error) =>
            error instanceof Gone ? new Response('gone', { status: 410 }) : undefined,
          )
          .shouldRenderJsonWhen(() => true),
      )
      .create()
    const logger = new MemoryLogger()
    app.container.value(LoggerToken, logger)
    const status = async (path: string): Promise<number> =>
      (await app.handle(new Request(`http://localhost${path}`))).status
    expect(await status('/declined')).toBe(500)
    expect(await status('/gone')).toBe(410)
    expect(await status('/silent')).toBe(500)
    expect(await status('/broken-reporter')).toBe(500)
    expect(await status('/early')).toBe(302)
    const value = await app.handle(new Request('http://localhost/value'))
    expect(value.status).toBe(500)
    expect(await value.text()).toContain('internal_error')
    expect(reported).toEqual(['gone', 'handled by a tracker', 'a string, not an error'])
    expect(logger.messages('error')).toEqual([
      'Unhandled error while serving a request',
      'An exception reporter failed',
      'Unhandled error while serving a request',
      'Unhandled error while serving a request',
    ])
  })
})
