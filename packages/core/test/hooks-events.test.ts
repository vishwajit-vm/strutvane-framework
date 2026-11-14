import { describe, expect, test, vi } from 'vitest'
import { createEventBus, createHooks, createTestClock, HookError } from '../src/index.ts'

type Hooks = { 'resource.beforeQuery': { filters: string[] }; other: number }

describe('hooks', () => {
  test('runs handlers in registration order and lets them transform the payload', async () => {
    const hooks = createHooks<Hooks>()
    hooks.on('resource.beforeQuery', (p) => ({ filters: [...p.filters, 'a'] }), { name: 'a' })
    hooks.on('resource.beforeQuery', () => undefined, { name: 'noop' })
    hooks.on('resource.beforeQuery', (p) => ({ filters: [...p.filters, 'b'] }), { name: 'b' })
    expect(await hooks.run('resource.beforeQuery', { filters: [] })).toEqual({
      filters: ['a', 'b'],
    })
  })

  test('honours before/after hints and ignores hints for absent handlers', async () => {
    const hooks = createHooks<Hooks>()
    const order: string[] = []
    hooks.on('other', () => void order.push('logs'), { name: 'logs', after: ['auth', 'missing'] })
    hooks.on('other', () => void order.push('auth'), { name: 'auth' })
    hooks.on('other', () => void order.push('first'), { name: 'first', before: 'auth' })
    expect(hooks.order('other')).toEqual(['first', 'auth', 'logs'])
    await hooks.run('other', 1)
    expect(order).toEqual(['first', 'auth', 'logs'])
  })

  test('rejects contradictory hints at registration and duplicate names', () => {
    const hooks = createHooks<Hooks>()
    hooks.on('other', () => undefined, { name: 'a', before: 'b' })
    expect(() => hooks.on('other', () => undefined, { name: 'b', before: 'a' })).toThrow(
      /Contradictory/,
    )
    expect(() => hooks.on('other', () => undefined, { name: 'a' })).toThrow(/already registered/)
    expect(() => hooks.on('other', () => undefined, { name: '' })).toThrow(TypeError)
    // The rejected registration did not leave a half-registered handler behind.
    expect(hooks.order('other')).toEqual(['a'])
  })

  test('stop() short-circuits the chain', async () => {
    const hooks = createHooks<Hooks>()
    const later = vi.fn()
    hooks.on(
      'other',
      (n, c) => {
        c.stop()
        return n + 1
      },
      { name: 'stopper' },
    )
    hooks.on('other', later, { name: 'later' })
    expect(await hooks.run('other', 1)).toBe(2)
    expect(later).not.toHaveBeenCalled()
  })

  test('errors abort by default with hook and handler names (fail closed)', async () => {
    const hooks = createHooks<Hooks>()
    hooks.on(
      'other',
      () => {
        throw new Error('boom')
      },
      { name: 'auth.scope' },
    )
    const error = await hooks.run('other', 1).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HookError)
    expect((error as HookError).hook).toBe('other')
    expect((error as HookError).handler).toBe('auth.scope')
    expect((error as Error).message).toContain('boom')
  })

  test('failSoft handlers report and continue', async () => {
    const reported: HookError[] = []
    const hooks = createHooks<Hooks>((e) => reported.push(e))
    hooks.on(
      'other',
      () => {
        throw 'not an Error'
      },
      { name: 'soft', failSoft: true },
    )
    hooks.on('other', (n) => n * 10, { name: 'after' })
    expect(await hooks.run('other', 2)).toBe(20)
    expect(reported[0]?.handler).toBe('soft')
  })

  test('unregister removes the handler', async () => {
    const hooks = createHooks<Hooks>()
    const off = hooks.on('other', (n) => n + 1, { name: 'x' })
    off()
    expect(await hooks.run('other', 1)).toBe(1)
  })
})

type Events = { 'invoice.sent': { id: string }; 'invoice.paid': { id: string } }

describe('event bus', () => {
  test('builds a DomainEvent and delivers it to every listener', async () => {
    const clock = createTestClock(Date.UTC(2026, 10, 14))
    const bus = createEventBus<Events>({ clock, ids: () => 'evt-1' })
    const got: unknown[] = []
    bus.on('invoice.sent', (e) => void got.push(e))
    const result = await bus.emit(
      'invoice.sent',
      { id: 'inv-1' },
      { tenantId: 't1', correlationId: 'c1' },
    )
    expect(result.delivered).toBe(1)
    expect(result.errors).toEqual([])
    expect(got[0]).toEqual({
      id: 'evt-1',
      type: 'invoice.sent',
      version: 1,
      payload: { id: 'inv-1' },
      occurredAt: '2026-11-14T00:00:00.000Z',
      idempotencyKey: 'evt-1',
      tenantId: 't1',
      correlationId: 'c1',
    })
    expect(Object.isFrozen(got[0])).toBe(true)
  })

  test('isolates listener failures (sync and async) and reports them', async () => {
    const onListenerError = vi.fn()
    const bus = createEventBus<Events>({ onListenerError })
    const ok = vi.fn()
    bus.on('invoice.paid', () => {
      throw new Error('sync fail')
    })
    bus.on('invoice.paid', async () => {
      throw new Error('async fail')
    })
    bus.on('invoice.paid', ok)
    const result = await bus.emit(
      'invoice.paid',
      { id: 'x' },
      { version: 2, idempotencyKey: 'k', actor: { id: 'u', type: 'user' } },
    )
    expect(ok).toHaveBeenCalledOnce()
    expect(result.errors).toHaveLength(2)
    expect(onListenerError).toHaveBeenCalledTimes(2)
    expect(result.event.idempotencyKey).toBe('k')
    expect(result.event.version).toBe(2)
  })

  test('a throwing error reporter never breaks delivery', async () => {
    const bus = createEventBus<Events>({
      onListenerError: () => {
        throw new Error('reporter broken')
      },
    })
    bus.on('invoice.paid', () => {
      throw new Error('x')
    })
    await expect(bus.emit('invoice.paid', { id: 'x' })).resolves.toMatchObject({ delivered: 1 })
  })

  test('throwListenerErrors makes emit reject with every error', async () => {
    const bus = createEventBus<Events>({ throwListenerErrors: true })
    bus.on('invoice.paid', () => {
      throw new Error('x')
    })
    await expect(bus.emit('invoice.paid', { id: 'x' })).rejects.toBeInstanceOf(AggregateError)
  })

  test('once() fires a single time; unsubscribe works; counts are tracked', async () => {
    const bus = createEventBus<Events>()
    const once = vi.fn()
    const always = vi.fn()
    bus.once('invoice.sent', once)
    const off = bus.on('invoice.sent', always)
    expect(bus.listenerCount('invoice.sent')).toBe(2)
    await bus.emit('invoice.sent', { id: '1' })
    await bus.emit('invoice.sent', { id: '2' })
    off()
    await bus.emit('invoice.sent', { id: '3' })
    expect(once).toHaveBeenCalledOnce()
    expect(always).toHaveBeenCalledTimes(2)
    expect(bus.listenerCount('invoice.sent')).toBe(0)
  })
})
