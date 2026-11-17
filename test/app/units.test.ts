/**
 * Unit tests for the small pieces the end-to-end suites don't reach: the in-memory counter store,
 * metadata-derived validation, the context helpers, the middleware configuration's guards, the
 * throttle limiter rules, method spoofing edges and the test client.
 */
import { describe, expect, it } from 'vitest'
import { createTestClock } from '../../src/core/clock.ts'
import { createContainer } from '../../src/core/container.ts'
import { spoofedMethod } from '../../src/foundation/method-spoofing.ts'
import {
  HttpContext,
  hasBearer,
  isJsonMediaType,
  readLimitedText,
} from '../../src/http/app/context.ts'
import { MemoryCacheStore } from '../../src/http/app/memory-cache.ts'
import {
  buildMiddleware,
  MiddlewareConfig,
  parseMiddleware,
  referenceFor,
  sortByPriority,
} from '../../src/http/app/middleware.ts'
import type { ResourceField, ResourceMetadata } from '../../src/http/app/resource-model.ts'
import { ipBucket, resolveLimiter } from '../../src/http/app/throttle.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { toIssue, validateInput } from '../../src/validation/form-request.ts'
import { isWritable, schemaFromMetadata } from '../../src/validation/from-metadata.ts'
import { customApp } from './helpers.ts'

describe('MemoryCacheStore', () => {
  it('stores, adds, counts in fixed windows, expires and stays bounded', async () => {
    const clock = createTestClock(0)
    const store = new MemoryCacheStore({ clock, maxEntries: 3 })
    await store.put('a', { n: 1 }, 10)
    expect(await store.get('a')).toEqual({ n: 1 })
    expect(await store.has('a')).toBe(true)
    expect(await store.add('a', 2)).toBe(false)
    expect(await store.add('b', 2)).toBe(true)
    expect(await store.ttl('b')).toBeUndefined()
    expect(await store.increment('count', 1, 60)).toBe(1)
    clock.advance(30_000)
    expect(await store.increment('count', 2, 60)).toBe(3)
    expect(await store.ttl('count')).toBe(30)
    clock.advance(31_000)
    expect(await store.increment('count', 1, 60)).toBe(1)
    expect(await store.get('a')).toBeUndefined()
    await store.put('c', 'x')
    await store.put('d', 'y')
    await store.put('e', 'z')
    expect(await store.has('b')).toBe(false)
    expect(await store.forget('e')).toBe(true)
    await store.flush()
    expect(await store.has('d')).toBe(false)
    await store.put('text', 'not a number')
    expect(await store.increment('text')).toBe(1)
  })
})

describe('metadata-derived validation', () => {
  const field = (name: string, extra: Partial<ResourceField> = {}): ResourceField => ({
    name,
    label: name.toUpperCase(),
    kind: 'string',
    cast: 'string',
    nullable: false,
    required: false,
    fillable: true,
    unique: false,
    hidden: false,
    ...extra,
  })
  const resource: ResourceMetadata = {
    table: 'things',
    model: 'Thing',
    label: { singular: 'Thing', plural: 'Things' },
    primaryKey: 'id',
    fields: [
      field('id', { kind: 'id' }),
      field('count', { cast: 'integer', required: true }),
      field('price', { cast: 'decimal' }),
      field('ratio', { cast: 'number' }),
      field('active', { cast: 'boolean' }),
      field('starts', { cast: 'datetime' }),
      field('day', { cast: 'date' }),
      field('extra', { cast: 'json' }),
      field('name', { required: true, maxLength: 5 }),
      field('kind', { options: ['a', 'b'] }),
      field('secret', { hidden: true }),
      field('created_at', { cast: 'datetime' }),
      field('is_admin', { cast: 'boolean' }),
      field('owner_id', { cast: 'integer', references: 'users' }),
      field('team_id', { cast: 'integer', references: 'teams' }),
      field('locked', { fillable: false }),
      field('note', { nullable: true }),
    ],
  }

  it('writes only safe columns by default, exactly fillable when given', () => {
    const writable = resource.fields
      .filter((entry) => isWritable(entry, undefined, ['users']))
      .map((entry) => entry.name)
    expect(writable).toEqual([
      'count',
      'price',
      'ratio',
      'active',
      'starts',
      'day',
      'extra',
      'name',
      'kind',
      'team_id',
      'note',
    ])
    expect(
      resource.fields
        .filter((entry) => isWritable(entry, ['name', 'secret', 'id'], ['users']))
        .map((entry) => entry.name),
    ).toEqual(['name'])
  })

  it('validates every cast with friendly messages, all at once', async () => {
    const create = schemaFromMetadata(resource, 'create')
    const valid = {
      count: 2,
      price: 1.5,
      ratio: 0.5,
      active: true,
      starts: '2026-11-14T10:00:00Z',
      day: '2026-11-14',
      extra: { a: 1 },
      name: 'Ann',
      kind: 'a',
      note: null,
    }
    expect(await validateInput(create, valid)).toMatchObject({ count: 2, name: 'Ann' })
    const failure = await validateInput(create, {
      count: 1.5,
      price: 'x',
      ratio: 'y',
      active: 'yes',
      starts: 'soon',
      day: 'today',
      name: 'Too long name',
      kind: 'c',
    }).catch((error: unknown) => error)
    const messages = (failure as { issues: { message: string }[] }).issues.map(
      (issue) => issue.message,
    )
    expect(messages).toEqual(
      expect.arrayContaining([
        'COUNT must be a whole number.',
        'PRICE must be a number.',
        'RATIO must be a number.',
        'ACTIVE must be true or false.',
        'NAME can be at most 5 characters.',
        'KIND must be one of: a, b.',
      ]),
    )
    const missing = await validateInput(create, {}).catch((error: unknown) => error)
    expect(
      (missing as { issues: { message: string }[] }).issues.map((issue) => issue.message),
    ).toEqual(['COUNT is required.', 'NAME is required.'])
    const update = schemaFromMetadata(resource, 'update')
    expect(await validateInput(update, {})).toEqual({})
    // A required column can't be blanked by an update either.
    await expect(validateInput(update, { name: '' })).rejects.toMatchObject({ status: 422 })
    expect(await validateInput(update, { note: null })).toEqual({ note: null })
    await expect(validateInput(create, { ...valid, name: '  ' })).rejects.toMatchObject({
      issues: [expect.objectContaining({ message: "NAME can't be empty." })],
    })
  })

  it('maps Standard Schema issues to the core shape and refuses unknown keys', async () => {
    expect(toIssue({ message: 'Too short', path: ['lines', { key: 2 }, 'amount'] })).toEqual({
      path: ['lines', 2, 'amount'],
      code: 'invalid',
      message: 'Too short',
    })
    expect(toIssue({ message: 'Bad', code: 'too_small' } as never)).toEqual({
      path: [],
      code: 'too_small',
      message: 'Bad',
    })
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => ({ value: 'not an object' as unknown as object }),
      },
    }
    await expect(validateInput(schema, {})).rejects.toMatchObject({
      issues: [{ path: [], code: 'invalid_body' }],
    })
  })
})

describe('HttpContext helpers', () => {
  const request = new Request('http://localhost/api/x?page=2', {
    method: 'POST',
    headers: {
      cookie: 'theme=dark; strutvane_session=s1',
      accept: 'text/html',
      'content-type': 'application/vnd.api+json',
    },
    body: '{"a":1}',
  })

  it('reads cookies, query, params and bound models, and explains mistakes', async () => {
    const ctx = new HttpContext({ request })
    expect(ctx.cookie('theme')).toBe('dark')
    expect(ctx.cookie('missing')).toBeUndefined()
    expect(ctx.query.get('page')).toBe('2')
    expect(ctx.sessionCookieValue()).toBeUndefined()
    expect(ctx.sessionCookie).toBeUndefined()
    expect(ctx.wantsJson()).toBe(true)
    expect(
      new HttpContext({
        request: new Request('http://localhost/page', { headers: { accept: 'text/html' } }),
      }).wantsJson(),
    ).toBe(false)
    expect(() => ctx.param('post')).toThrow(
      expect.objectContaining({ code: 'unknown_route_parameter' }),
    )
    class Thing {}
    expect(() => ctx.model(Thing)).toThrow(expect.objectContaining({ code: 'model_not_bound' }))
    const routed = ctx.forRoute(
      { name: undefined, method: 'POST', uri: '/api/x/{thing}', action: 'Closure' },
      { thing: '7' },
    )
    const thing = new Thing()
    routed.bindModel('thing', thing)
    expect(ctx.model(Thing)).toBe(thing)
    expect(ctx.model(Thing, 'thing')).toBe(thing)
    expect(ctx.bound('thing')).toBe(thing)
    expect(await ctx.body()).toEqual({ a: 1 })
    expect(await routed.body()).toEqual({ a: 1 })
    expect(() => ctx.defer('nope' as never)).toThrow(
      expect.objectContaining({ code: 'invalid_deferred_task' }),
    )
    expect(ctx.noContent().status).toBe(204)
    expect(ctx.html('<p>', 201, { 'x-a': '1' }).headers.get('x-a')).toBe('1')
    expect(() => ctx.requireUser()).toThrow(expect.objectContaining({ status: 401 }))
    ctx.tenant = { id: 'acme', strategy: 'shared' }
    expect(routed.tenant?.id).toBe('acme')
  })

  it('checks media types by essence, bearer headers and body sizes', async () => {
    expect(isJsonMediaType('application/problem+json')).toBe(true)
    expect(isJsonMediaType('text/plain; x=application/json')).toBe(false)
    expect(isJsonMediaType(null)).toBe(false)
    expect(hasBearer(new Request('http://x', { headers: { authorization: 'bearer abc' } }))).toBe(
      true,
    )
    await expect(
      readLimitedText(
        new Request('http://x', {
          method: 'POST',
          headers: { 'content-length': '999' },
          body: 'x',
        }),
        10,
      ),
    ).rejects.toMatchObject({ status: 413 })
    expect(await readLimitedText(new Request('http://x'), 10)).toBe('')
  })
})

describe('MiddlewareConfig guards', () => {
  it('refuses bad aliases, limiters, abilities and group cycles', () => {
    const config = new MiddlewareConfig()
    class Valid {
      async handle(): Promise<Response> {
        return new Response()
      }
    }
    expect(() => config.alias({ 'bad name': Valid })).toThrow(
      expect.objectContaining({ code: 'invalid_middleware_alias' }),
    )
    expect(() => config.rateLimiter('x', { maxAttempts: 0, decaySeconds: 60 })).toThrow(
      expect.objectContaining({ code: 'invalid_rate_limiter' }),
    )
    expect(() => config.defineAbility('x', 'yes' as never)).toThrow(
      expect.objectContaining({ code: 'invalid_ability' }),
    )
    config.appendToGroup('loop', 'loop')
    expect(() => config.expandGroups(['loop'], 'GET /')).toThrow(
      expect.objectContaining({ code: 'middleware_group_cycle' }),
    )
    expect(() => config.expandGroups(['zzzzzzzzz'], 'GET /')).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('Known: ') }),
    )
    expect(config.isGroup('web')).toBe(true)
    expect(config.group('nope')).toEqual([])
    expect(config.limiterNames).toEqual(['api', 'login', 'password-reset', 'aggregate'])
    expect(config.timeoutMs).toBe(30_000)
    config
      .alias({ valid: Valid })
      .trustProxies(1)
      .trustHosts({ at: ['example.com'] })
      .cors({ origins: ['https://a.example.com'] })
    expect(config.aliasNames).toEqual(['valid'])
    expect(() => buildMiddleware(createContainer(), class NoHandle {} as never)).toThrow(
      expect.objectContaining({ code: 'not_middleware' }),
    )
  })

  it('parses references and orders priority middleware', () => {
    expect(parseMiddleware('throttle:60,1')).toEqual({ alias: 'throttle', params: ['60', '1'] })
    expect(referenceFor('can', ['x'])).toBe('can:x')
    const order = sortByPriority([
      { alias: 'idempotent', params: [] },
      { alias: 'throttle', params: ['api'] },
      { alias: 'custom', params: [] },
      { alias: 'auth', params: [] },
      { alias: 'csrf', params: [] },
      { alias: 'signed', params: [] },
    ]).map((reference) => reference.alias)
    expect(order).toEqual(['csrf', 'signed', 'custom', 'auth', 'throttle', 'idempotent'])
  })
})

describe('throttle limiters and buckets', () => {
  it('reads numbers or names, and refuses nonsense', () => {
    const config = new MiddlewareConfig()
    expect(resolveLimiter(['10'], config)).toEqual({
      name: '10,1',
      definition: { maxAttempts: 10, decaySeconds: 60 },
    })
    expect(resolveLimiter([], config).name).toBe('api')
    expect(() => resolveLimiter(['10', 'x'], config)).toThrow(
      expect.objectContaining({ code: 'invalid_throttle' }),
    )
    expect(() => resolveLimiter(['0'], config)).toThrow(
      expect.objectContaining({ code: 'invalid_throttle' }),
    )
    expect(() => resolveLimiter(['zzzzzzzzzz'], config)).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('Define it in bootstrap/app.ts') }),
    )
  })

  it('buckets IPv6 by /64 and leaves IPv4 and unknown addresses alone', () => {
    expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('2001:0db8:0001:0002::9')).toBe('2001:db8:1:2::/64')
    expect(ipBucket('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7')
    expect(ipBucket('unknown')).toBe('unknown')
  })

  it('a limiter may choose its own key (the aggregate limiter is one bucket for everyone)', async () => {
    const prepared = await customApp({}, (m) =>
      m.rateLimiter('aggregate', { maxAttempts: 1, decaySeconds: 60, by: () => 'all' }),
    )
    const routes = await customApp(
      {
        web: defineRoutes([
          Route.get('/shared', (ctx) => ctx.json({})).middleware('throttle:aggregate'),
        ]),
      },
      (m) => m.rateLimiter('aggregate', { maxAttempts: 1, decaySeconds: 60, by: () => 'all' }),
    )
    ;(await routes.client.fromIp('198.51.100.1').getJson('/shared')).assertStatus(200)
    ;(await routes.client.fromIp('198.51.100.2').getJson('/shared')).assertStatus(429)
    expect(prepared.app.middleware.limiter('aggregate')?.maxAttempts).toBe(1)
  })
})

describe('method spoofing edges', () => {
  const post = (body: string | null, type = 'application/x-www-form-urlencoded'): Request =>
    new Request('http://x/', {
      method: 'POST',
      headers: { 'content-type': type },
      ...(body === null ? {} : { body }),
    })

  it('keeps POST for other bodies, empty fields, oversized forms and bodiless requests', async () => {
    expect(await spoofedMethod(post('_method=PATCH'))).toBe('PATCH')
    expect(await spoofedMethod(post('_method='))).toBe('POST')
    expect(await spoofedMethod(post('title=x'))).toBe('POST')
    expect(await spoofedMethod(post('{"_method":"DELETE"}', 'application/json'))).toBe('POST')
    expect(await spoofedMethod(post(`_method=DELETE&pad=${'x'.repeat(70 * 1024)}`))).toBe('POST')
    expect(await spoofedMethod(post(null))).toBe('POST')
    expect(await spoofedMethod(new Request('http://x/', { method: 'GET' }))).toBe('GET')
  })
})

describe('the test client', () => {
  it('sends cookies, forms, raw requests and reads paths', async () => {
    const prepared = await customApp({
      web: defineRoutes([
        Route.get('/cookies', (ctx) =>
          ctx.json({ a: ctx.cookie('a') ?? null, b: ctx.cookie('b') ?? null }),
        ),
        Route.post('/form', async (ctx) => ctx.json({ form: await ctx.request.text() })),
      ]),
    })
    const response = await prepared.client
      .withCookie('a', '1')
      .withCookie('b', '2')
      .getJson('/cookies')
    response.assertJsonPath('a', '1').assertJsonPath('b', '2')
    expect(response.path('missing.deeper')).toBeUndefined()
    expect(() => response.assertStatus(404)).toThrow(/Expected status 404, got 200/)
    expect(() => response.assertJsonPath('a', '2')).toThrow(/Expected a to be "2"/)
    expect(() => response.assertProblem(200, 'x')).toThrow(/Expected problem\+json/)
    ;(await prepared.client.withoutCsrf().postForm('/form', { title: 'Hi' })).assertJsonPath(
      'form',
      'title=Hi',
    )
  })
})
