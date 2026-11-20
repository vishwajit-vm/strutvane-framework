/**
 * The blog fixture end to end: real requests through the kernel, routing, middleware, binding,
 * controllers, form requests and policies (discovered from app/policies), on in-memory models
 * that implement the ResourceModel contract.
 */
import { describe, expect, it } from 'vitest'
import { blogApp, tokens } from './helpers.ts'

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })
const titles = (body: unknown): string[] =>
  ((body as { data?: { title: string }[] }).data ?? []).map((post) => post.title)

describe('index: visibility, pagination and list validation', () => {
  it('shows guests only published posts, authors their drafts too, admins everything', async () => {
    const { client } = await blogApp()
    const guest = await client.getJson('/api/posts')
    guest.assertStatus(200).assertJsonPath('meta.total', 3)
    expect(titles(guest.json)).toEqual(['Hello World', 'Routing like Laravel', 'Bob on policies'])
    ;(await client.withHeaders(bearer(tokens.alice)).getJson('/api/posts')).assertJsonPath(
      'meta.total',
      4,
    )
    ;(await client.withHeaders(bearer(tokens.admin)).getJson('/api/posts')).assertJsonPath(
      'meta.total',
      5,
    )
  })

  it('paginates and sorts, and reports bad list parameters as one 422', async () => {
    const { client } = await blogApp()
    ;(await client.getJson('/api/posts?perPage=2&page=2')).assertJsonPath('meta', {
      page: 2,
      perPage: 2,
      total: 3,
    })
    expect(titles((await client.getJson('/api/posts?sort=-title')).json)).toEqual([
      'Routing like Laravel',
      'Hello World',
      'Bob on policies',
    ])
    const bad = await client.getJson('/api/posts?sort=secret&page=0&filter[api_token]=x')
    bad.assertProblem(422, 'validation_failed')
    expect((bad.json as { issues: { code: string }[] }).issues.map((issue) => issue.code)).toEqual([
      'invalid_integer',
      'sort_not_allowed',
      'filter_not_allowed',
    ])
  })

  it('never returns hidden columns', async () => {
    const { client } = await blogApp()
    const response = await client.getJson('/api/authors')
    expect(response.text).not.toContain('api_token')
    response.assertJsonPath('data.0.name', 'Ada Admin')
  })
})

describe('show and route model binding', () => {
  it('binds by slug ({post:slug}) and 404s for a missing post', async () => {
    const { client } = await blogApp()
    ;(await client.getJson('/api/posts/hello-world'))
      .assertStatus(200)
      .assertJsonPath('data.title', 'Hello World')
    ;(await client.getJson('/api/posts/nope')).assertProblem(404, 'not_found')
  })

  it('binds authors by id and refuses non-numeric ids without a lookup', async () => {
    const { client } = await blogApp()
    ;(await client.getJson('/api/authors/2')).assertJsonPath('data.name', 'Alice Writer')
    ;(await client.getJson('/api/authors/2abc')).assertProblem(404, 'not_found')
  })

  it('answers a draft the user may not see exactly like a missing one (deny as 404)', async () => {
    const { client } = await blogApp()
    const hidden = await client.withHeaders(bearer(tokens.bob)).getJson('/api/posts/alice-draft')
    const missing = await client.withHeaders(bearer(tokens.bob)).getJson('/api/posts/no-such-post')
    hidden.assertProblem(404, 'not_found')
    expect(hidden.path('title')).toBe(missing.path('title'))
    ;(
      await client.withHeaders(bearer(tokens.alice)).getJson('/api/posts/alice-draft')
    ).assertStatus(200)
  })

  it("serves the web side as the React shell with this response's nonce, and binds there too", async () => {
    const { client } = await blogApp()
    const page = await client.get('/posts/hello-world')
    page.assertStatus(200)
    expect(page.text).toContain('<title>Blog Test</title>')
    const nonce = /nonce="([^"]+)"/.exec(page.text)?.[1] ?? ''
    expect(page.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`)
    ;(await client.get('/posts/nope')).assertStatus(404)
  })
})

describe('store: form requests, policies and problem+json', () => {
  it('needs a signed-in user (401 with WWW-Authenticate)', async () => {
    const { client } = await blogApp()
    const response = await client.postJson('/api/posts', { title: 'Hello' })
    response.assertProblem(401, 'unauthenticated')
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    ;(
      await client.withHeaders(bearer('wrong-token')).postJson('/api/posts', { title: 'Hello' })
    ).assertProblem(401, 'unauthenticated')
  })

  it('validates with the form request and reports every field issue with its path', async () => {
    const { client } = await blogApp()
    const response = await client
      .withHeaders(bearer(tokens.alice))
      .postJson('/api/posts', { title: 'Hi', status: 'archived', slug: 'Not A Slug' })
    response.assertProblem(422, 'validation_failed')
    const issues = (response.json as { issues: { path: string[]; message: string }[] }).issues
    expect(issues.map((issue) => issue.path.join('.')).sort()).toEqual(['slug', 'status', 'title'])
    expect(issues.find((issue) => issue.path[0] === 'title')?.message).toBe(
      'Title must be at least 3 characters.',
    )
  })

  it('rejects fields the request does not accept (author_id can never be forged)', async () => {
    const { client } = await blogApp()
    const response = await client
      .withHeaders(bearer(tokens.alice))
      .postJson('/api/posts', { title: 'Forged', author_id: 3 })
    response.assertProblem(422, 'validation_failed')
    expect(response.path('issues')).toEqual([
      expect.objectContaining({ path: ['author_id'], code: 'unknown_field' }),
    ])
  })

  it('creates with the author from the user, a slug and a Location header', async () => {
    const { client } = await blogApp()
    const response = await client
      .withHeaders(bearer(tokens.bob))
      .postJson('/api/posts', { title: 'Crème brûlée tips', status: 'published' })
    response
      .assertStatus(201)
      .assertJsonPath('data.slug', 'creme-brulee-tips')
      .assertJsonPath('data.author_id', 3)
    expect(response.headers.get('location')).toBe('/api/posts/creme-brulee-tips')
  })

  it('gives a colliding title a random slug suffix, not a counter', async () => {
    const { client } = await blogApp()
    const response = await client
      .withHeaders(bearer(tokens.bob))
      .postJson('/api/posts', { title: 'Alice draft' })
    expect(String(response.assertStatus(201).path('data.slug'))).toMatch(
      /^alice-draft-[a-z0-9]{4}$/,
    )
  })

  it('returns friendly 4xx for bad bodies: 415, 400, 413 and a non-object', async () => {
    const { client } = await blogApp()
    const alice = client.withHeaders(bearer(tokens.alice))
    ;(
      await alice
        .withHeaders({ 'content-type': 'text/plain' })
        .send('POST', '/api/posts', 'title=x')
    ).assertProblem(415, 'unsupported_media_type')
    ;(await alice.send('POST', '/api/posts', '{"title": ')).assertProblem(400, 'invalid_json')
    ;(await alice.postJson('/api/posts', { title: 'x'.repeat(1024 * 1024) })).assertProblem(
      413,
      'payload_too_large',
    )
    ;(await alice.postJson('/api/posts', ['not', 'an', 'object']))
      .assertProblem(422, 'validation_failed')
      .assertJsonPath('issues.0.code', 'invalid_body')
  })

  it('derives author validation from metadata, narrowed by Author.fillable, with unique checks', async () => {
    const { client } = await blogApp()
    ;(
      await client
        .withHeaders(bearer(tokens.alice))
        .postJson('/api/authors', { name: 'X', email: 'x@example.test' })
    ).assertProblem(403, 'forbidden')
    const admin = client.withHeaders(bearer(tokens.admin))
    const escalation = await admin.postJson('/api/authors', {
      name: 'Eve',
      email: 'eve@example.test',
      is_admin: true,
    })
    escalation.assertProblem(422, 'validation_failed').assertJsonPath('issues.0.path', ['is_admin'])
    const taken = await admin.postJson('/api/authors', { name: 'Eve', email: 'alice@example.test' })
    taken.assertProblem(422, 'validation_failed').assertJsonPath('issues.0.code', 'unique')
    const missing = await admin.postJson('/api/authors', { email: 42 })
    expect(
      (missing.json as { issues: { message: string }[] }).issues.map((issue) => issue.message),
    ).toEqual(['Name is required.', 'Email must be text.'])
    ;(await admin.postJson('/api/authors', { name: 'Eve', email: 'eve@example.test' }))
      .assertStatus(201)
      .assertJsonPath('data.is_admin', false)
  })
})

describe('update, destroy and custom actions: policies deny by default', () => {
  it('lets only the author update (others get 403)', async () => {
    const { client } = await blogApp()
    ;(
      await client
        .withHeaders(bearer(tokens.bob))
        .patchJson('/api/posts/hello-world', { title: 'Hacked' })
    ).assertProblem(403, 'forbidden')
    const alice = client.withHeaders(bearer(tokens.alice))
    ;(await alice.patchJson('/api/posts/hello-world', { title: 'Hello again' }))
      .assertStatus(200)
      .assertJsonPath('data.title', 'Hello again')
    ;(await alice.putJson('/api/posts/hello-world', { body: null }))
      .assertStatus(200)
      .assertJsonPath('data.body', null)
  })

  it('denies delete when the policy has no delete() (even to the author); admins pass through before()', async () => {
    const { client } = await blogApp()
    ;(
      await client.withHeaders(bearer(tokens.alice)).deleteJson('/api/posts/hello-world')
    ).assertProblem(403, 'forbidden')
    ;(
      await client.withHeaders(bearer(tokens.admin)).deleteJson('/api/posts/hello-world')
    ).assertStatus(204)
    ;(await client.getJson('/api/posts/hello-world')).assertProblem(404, 'not_found')
    ;(await client.getJson('/api/posts')).assertJsonPath('meta.total', 2)
  })

  it('runs a custom action with typed route() links and a discovered listener', async () => {
    const { client, logger } = await blogApp()
    ;(
      await client.withHeaders(bearer(tokens.bob)).postJson('/api/posts/alice-draft/publish', {})
    ).assertProblem(404, 'not_found')
    const published = await client
      .withHeaders(bearer(tokens.alice))
      .postJson('/api/posts/alice-draft/publish', {})
    published
      .assertStatus(200)
      .assertJsonPath('data.status', 'published')
      .assertJsonPath('links.self', '/api/posts/alice-draft')
    expect(logger.entries).toContainEqual({
      level: 'info',
      message: 'Post published',
      fields: { post: '3' },
    })
  })

  it('injects constructor dependencies and guards groups with middleware', async () => {
    const { client } = await blogApp()
    ;(await client.getJson('/api/admin/stats')).assertProblem(401, 'unauthenticated')
    ;(await client.withHeaders(bearer(tokens.alice)).getJson('/api/admin/stats')).assertProblem(
      403,
      'forbidden',
    )
    ;(await client.withHeaders(bearer(tokens.admin)).getJson('/api/admin/stats'))
      .assertStatus(200)
      .assertJsonPath('data', { posts: 5, authors: 3 })
    ;(await client.withHeaders(bearer(tokens.bob)).getJson('/api/me')).assertJsonPath(
      'data.name',
      'Bob Reader',
    )
    ;(await client.getJson('/api/ping')).assertJsonPath('pong', true)
  })
})

describe('the HTTP edges', () => {
  it('has /up for GET and HEAD', async () => {
    const { client } = await blogApp()
    ;(await client.getJson('/up')).assertStatus(200).assertJsonPath('status', 'ok')
    const head = await client.request(new Request('http://localhost/up', { method: 'HEAD' }))
    head.assertStatus(200)
    expect(head.text).toBe('')
  })

  it('answers 405 with Allow for a known path, problem 404 for an unknown API path', async () => {
    const { client } = await blogApp()
    const wrongMethod = await client.deleteJson('/api/posts')
    wrongMethod.assertProblem(405, 'method_not_allowed')
    expect(wrongMethod.headers.get('allow')).toBe('GET, HEAD, POST')
    ;(await client.getJson('/api/nothing-here')).assertProblem(404, 'not_found')
  })

  it('serves the web fallback for unknown pages, never for API paths or other methods', async () => {
    const { client } = await blogApp()
    const page = await client.get('/some/client/route')
    page.assertStatus(200)
    expect(page.text).toContain('<div id="root"></div>')
    ;(await client.getJson('/api/unknown')).assertProblem(404, 'not_found')
    ;(await client.getJson('/_strutvane/unknown')).assertProblem(404, 'not_found')
    // A path that exists for another method stays a 405, never the fallback.
    ;(
      await client.withHeaders(bearer(tokens.alice)).getJson('/api/posts/hello-world/publish')
    ).assertProblem(405, 'method_not_allowed')
    ;(
      await client.withHeaders(bearer(tokens.alice)).postJson('/some/client/route', {})
    ).assertProblem(404, 'not_found')
  })

  it('throttles the api group by user then IP, with headers and Retry-After, and resets', async () => {
    const { client, clock } = await blogApp()
    let last = await client.getJson('/api/authors')
    for (let index = 1; index < 120; index += 1) last = await client.getJson('/api/authors')
    last.assertStatus(200)
    expect(last.headers.get('x-ratelimit-remaining')).toBe('0')
    const blocked = await client.getJson('/api/authors')
    blocked.assertProblem(429, 'rate_limited')
    expect(blocked.headers.get('retry-after')).toBe('60')
    // A signed-in user has their own bucket (auth runs before throttle).
    ;(await client.withHeaders(bearer(tokens.alice)).getJson('/api/admin/stats')).assertProblem(
      403,
      'forbidden',
    )
    // Another client address has its own bucket.
    ;(await client.fromIp('2001:db8:1:2::1').getJson('/api/authors')).assertStatus(200)
    clock.advance(61_000)
    ;(await client.getJson('/api/authors')).assertStatus(200)
  })
})
