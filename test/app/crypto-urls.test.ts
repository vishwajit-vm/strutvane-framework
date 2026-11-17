/**
 * Signed links through the `signed` middleware (tampering, expiry, one-time replay, key rotation,
 * purpose binding), the `idempotent` middleware's matrix (replay, reuse, 409 in flight, cross-user
 * isolation, retry after failure) and the `redirect()` helper's open-redirect guard.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redirect } from '../../src/foundation/helpers.ts'
import type { HttpContext } from '../../src/http/app/context.ts'
import { idempotent, withIdempotency, withSigned } from '../../src/http/app/protections.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { url } from '../../src/routing/url.ts'
import { APP_KEY, author, customApp, NOW } from './helpers.ts'

const files = {
  web: defineRoutes([
    Route.get('/files/{file}', (ctx) => ctx.json({ file: ctx.param('file') }))
      .name('files.show')
      .middleware('signed'),
    Route.get('/other/{file}', (ctx) => ctx.json({ other: true }))
      .name('other.show')
      .middleware('signed'),
    Route.get(
      '/unsubscribe/{user}',
      withSigned(async (ctx) => ctx.json({ unsubscribed: ctx.param('user') })),
    ).name('unsubscribe'),
  ]),
}

describe('the signed middleware', () => {
  it('accepts an untouched link and refuses tampering with path, query or signature', async () => {
    const { app, client } = await customApp(files)
    const link = app.run(() => url.signedRoute('files.show', { file: 'report' }))
    ;(await client.getJson(link)).assertStatus(200).assertJsonPath('file', 'report')
    ;(await client.getJson(link.replace('report', 'secret'))).assertProblem(
      403,
      'invalid_signature',
    )
    ;(await client.getJson(`${link}&extra=1`)).assertProblem(403, 'invalid_signature')
    ;(await client.getJson(link.slice(0, -2))).assertProblem(403, 'invalid_signature')
    ;(await client.getJson('/files/report')).assertProblem(403, 'invalid_signature')
    // A wrapped handler is protected the same way.
    const unsubscribe = app.run(() => url.signedRoute('unsubscribe', { user: 7 }))
    ;(await client.getJson(unsubscribe)).assertJsonPath('unsubscribed', '7')
    ;(await client.getJson('/unsubscribe/7')).assertProblem(403, 'invalid_signature')
  })

  it('binds a signature to its route: a link for one route never opens another', async () => {
    const { app, client } = await customApp(files)
    const link = app.run(() => url.signedRoute('files.show', { file: 'report' }))
    ;(await client.getJson(link.replace('/files/', '/other/'))).assertProblem(
      403,
      'invalid_signature',
    )
  })

  it('expires temporary links (by the app clock) and keeps the expiry signed', async () => {
    const { app, client, clock } = await customApp(files)
    const temporary = app.run(() =>
      url.temporarySignedRoute('files.show', NOW + 60_000, { file: 'report' }),
    )
    ;(await client.getJson(temporary)).assertStatus(200)
    ;(
      await client.getJson(
        temporary.replace(/expires=\d+/, `expires=${Math.floor(NOW / 1000) + 9_999_999}`),
      )
    ).assertProblem(403, 'invalid_signature')
    clock.advance(61_000)
    ;(await client.getJson(temporary)).assertProblem(403, 'signature_expired')
    const relative = app.run(() => url.signedRoute('files.show', { file: 'x' }, { expiresIn: 30 }))
    clock.advance(31_000)
    ;(await client.getJson(relative)).assertProblem(403, 'signature_expired')
  })

  it('one-time links work exactly once', async () => {
    const { app, client } = await customApp(files)
    const once = app.run(() =>
      url.signedRoute('files.show', { file: 'report' }, { expiresIn: 600, oneTime: true }),
    )
    ;(await client.getJson(once)).assertStatus(200)
    // The signer reports a used one-time link like an expired one ("ask for a new one").
    ;(await client.getJson(once)).assertProblem(403, 'signature_expired')
    // A link without an expiry can't be one-time (the store could never forget it).
    expect(() =>
      app.run(() => url.signedRoute('files.show', { file: 'x' }, { oneTime: true })),
    ).toThrow(/must also expire/)
    expect(() =>
      app.run(() => url.signedRoute('files.show', { file: 'x' }, { expiresIn: -1 })),
    ).toThrow(/positive number of seconds/)
  })

  it('keeps links signed with a previous key valid after rotation, and refuses unknown keys', async () => {
    const before = await customApp(files)
    const link = before.app.run(() => url.signedRoute('files.show', { file: 'report' }))
    const newKey = `base64:${randomBytes(32).toString('base64')}`
    const rotated = await customApp(files, () => {}, {
      APP_KEY: newKey,
      APP_PREVIOUS_KEYS: APP_KEY,
    })
    ;(await rotated.client.getJson(link)).assertStatus(200)
    const stranger = await customApp(files, () => {}, { APP_KEY: newKey })
    ;(await stranger.client.getJson(link)).assertProblem(403, 'invalid_signature')
  })
})

describe('the idempotent middleware', () => {
  async function paymentsApp(): Promise<{
    prepared: Awaited<ReturnType<typeof customApp>>
    charges: () => number
  }> {
    let charges = 0
    class PaymentController {
      static readonly middleware = [idempotent({ only: ['store'] })]
      async store(ctx: HttpContext): Promise<Response> {
        charges++
        const body = (await ctx.body()) as { amount?: number }
        return ctx.json({ charge: charges, amount: body.amount }, 201, {
          location: `/payments/${charges}`,
          'set-cookie': 'tracking=1',
        })
      }
    }
    const prepared = await customApp({
      api: defineRoutes([
        Route.post('/payments', [PaymentController, 'store']).middleware('auth'),
        Route.post(
          '/optional',
          withIdempotency(async (ctx) => ctx.json({ ran: true }), 'optional'),
        ),
        Route.post(
          '/broken',
          withIdempotency(async () => {
            charges++
            throw new Error('payment provider down')
          }),
        ),
      ]),
    })
    return { prepared, charges: () => charges }
  }

  it('runs once per key and replays the first response (without per-request headers)', async () => {
    const { prepared, charges } = await paymentsApp()
    const alice = prepared.client
      .actingAs(author(prepared, 2))
      .withHeaders({ 'idempotency-key': 'pay-1' })
    ;(await alice.postJson('/api/payments', { amount: 10 }))
      .assertStatus(201)
      .assertJsonPath('charge', 1)
    const retry = await alice.postJson('/api/payments', { amount: 10 })
    retry.assertStatus(201).assertJsonPath('charge', 1)
    expect(retry.headers.get('idempotent-replayed')).toBe('true')
    expect(retry.headers.get('location')).toBe('/payments/1')
    expect(retry.headers.get('set-cookie')).toBeNull()
    expect(charges()).toBe(1)
  })

  it('refuses a missing key, a malformed key, and a reused key with a different body', async () => {
    const { prepared } = await paymentsApp()
    const alice = prepared.client.actingAs(author(prepared, 2))
    ;(await alice.postJson('/api/payments', { amount: 1 })).assertProblem(
      400,
      'idempotency_key_required',
    )
    ;(
      await alice
        .withHeaders({ 'idempotency-key': 'has space' })
        .postJson('/api/payments', { amount: 1 })
    ).assertProblem(400, 'idempotency_key_invalid')
    await alice.withHeaders({ 'idempotency-key': 'k' }).postJson('/api/payments', { amount: 1 })
    ;(
      await alice.withHeaders({ 'idempotency-key': 'k' }).postJson('/api/payments', { amount: 999 })
    ).assertProblem(422, 'idempotency_key_reused')
    ;(await prepared.client.postJson('/api/optional', {})).assertStatus(200)
  })

  it("never serves one user the response stored for another user's key", async () => {
    const { prepared, charges } = await paymentsApp()
    await prepared.client
      .actingAs(author(prepared, 2))
      .withHeaders({ 'idempotency-key': 'shared' })
      .postJson('/api/payments', { amount: 5 })
    const bob = await prepared.client
      .actingAs(author(prepared, 3))
      .withHeaders({ 'idempotency-key': 'shared' })
      .postJson('/api/payments', { amount: 5 })
    bob.assertStatus(201).assertJsonPath('charge', 2)
    expect(bob.headers.get('idempotent-replayed')).toBeNull()
    expect(charges()).toBe(2)
  })

  it('answers 409 while the first request is still running, and lets a failed one retry', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = await customApp({
      api: defineRoutes([
        Route.post(
          '/slow',
          withIdempotency(async (ctx) => {
            await gate
            return ctx.json({ done: true })
          }),
        ),
      ]),
    })
    const guest = slow.client.withHeaders({ 'idempotency-key': 'slow-1' })
    const first = guest.postJson('/api/slow', {})
    ;(await guest.postJson('/api/slow', {})).assertProblem(409, 'idempotency_in_progress')
    release()
    ;(await first).assertStatus(200)
    const { prepared, charges } = await paymentsApp()
    const retry = prepared.client.withHeaders({ 'idempotency-key': 'b-1' })
    ;(await retry.postJson('/api/broken', {})).assertStatus(500)
    ;(await retry.postJson('/api/broken', {})).assertStatus(500)
    expect(charges()).toBe(2)
  })
})

describe('redirect()', () => {
  it('intended() falls back for hostile values; to() refuses them loudly; away() is explicit', async () => {
    const { app } = await customApp({
      web: defineRoutes([
        Route.get('/login/done', (ctx) => redirect().intended(ctx, '/dashboard')),
      ]),
    })
    const location = async (query: string): Promise<string | null> =>
      (await app.handle(new Request(`http://localhost/login/done${query}`))).headers.get('location')
    expect(await location('?intended=%2Fposts%2F7')).toBe('/posts/7')
    expect(await location('?intended=%2F%2Fevil.com')).toBe('/dashboard')
    expect(await location('?intended=https%3A%2F%2Fevil.com')).toBe('/dashboard')
    expect(await location('?intended=%2F%5Cevil.com')).toBe('/dashboard')
    expect(await location('')).toBe('/dashboard')
    expect(() => app.run(() => redirect().to('//evil.com'))).toThrow('not a same-origin path')
    expect(
      app.run(() => redirect().away('https://partner.example/x')).headers.get('location'),
    ).toBe('https://partner.example/x')
  })
})

describe('regression: a response too big to store for replay is still sent', () => {
  it('releases the key and answers (cloned-body cancel never hangs)', async () => {
    const prepared = await customApp({
      api: defineRoutes([
        Route.post(
          '/export',
          withIdempotency(async (ctx) => ctx.json({ blob: 'x'.repeat(1_100_000) })),
        ),
      ]),
    })
    const first = await prepared.client
      .withHeaders({ 'idempotency-key': 'big-1' })
      .postJson('/api/export', {})
    first.assertStatus(200)
    const again = await prepared.client
      .withHeaders({ 'idempotency-key': 'big-1' })
      .postJson('/api/export', {})
    expect(again.headers.get('idempotent-replayed')).toBeNull()
  })
})
