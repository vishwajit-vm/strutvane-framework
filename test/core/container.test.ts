import { describe, expect, test, vi } from 'vitest'
import { ContainerError, createContainer, token } from '../../src/core/index.ts'

const Num = token<number>('num')
const Str = token<string>('str')
const Obj = token<{ id: number }>('obj')

describe('token', () => {
  test('tokens with the same name are still distinct and frozen', () => {
    const a = token<number>('x')
    const b = token<number>('x')
    expect(a.id).not.toBe(b.id)
    expect(Object.isFrozen(a)).toBe(true)
  })
  test('rejects empty names', () => {
    expect(() => token(' ')).toThrow(TypeError)
  })
})

describe('lifetimes', () => {
  test('value returns the value; transient creates a new instance each time', () => {
    let n = 0
    const c = createContainer()
      .value(Str, 'hi')
      .bind(Obj, () => ({ id: ++n }))
    expect(c.make(Str)).toBe('hi')
    expect(c.make(Obj)).not.toBe(c.make(Obj))
    expect(n).toBe(2)
  })

  test('singleton is created once and shared by scopes', () => {
    const factory = vi.fn(() => ({ id: 1 }))
    const root = createContainer().singleton(Obj, factory)
    const s1 = root.createScope()
    const s2 = root.createScope()
    expect(s1.make(Obj)).toBe(s2.make(Obj))
    expect(root.make(Obj)).toBe(s1.make(Obj))
    expect(factory).toHaveBeenCalledTimes(1)
  })

  test('scoped is one instance per scope and refuses the root', () => {
    let n = 0
    const root = createContainer().scoped(Obj, () => ({ id: ++n }))
    const s1 = root.createScope()
    const s2 = root.createScope()
    expect(s1.make(Obj)).toBe(s1.make(Obj))
    expect(s1.make(Obj)).not.toBe(s2.make(Obj))
    expect(() => root.make(Obj)).toThrowError(expect.objectContaining({ code: 'SCOPE_REQUIRED' }))
  })

  test('scope-local bindings never leak to the parent', () => {
    const root = createContainer()
    const scope = root.createScope().value(Str, 'request-only')
    expect(scope.make(Str)).toBe('request-only')
    expect(root.has(Str)).toBe(false)
  })

  test('a singleton cannot capture a scoped dependency (resolved from its owner)', () => {
    const root = createContainer()
      .scoped(Num, () => 1)
      .singleton(Str, (r) => `n=${r.make(Num)}`)
    const scope = root.createScope()
    expect(() => scope.make(Str)).toThrowError(expect.objectContaining({ code: 'SCOPE_REQUIRED' }))
  })

  test('transient services get scoped dependencies from the current scope', () => {
    let n = 0
    const root = createContainer()
      .scoped(Num, () => ++n)
      .bind(Str, (r) => `n=${r.make(Num)}`)
    expect(root.createScope().make(Str)).toBe('n=1')
    expect(root.createScope().make(Str)).toBe('n=2')
  })
})

describe('errors', () => {
  test('unknown token names the token and the dependent', () => {
    const c = createContainer().bind(Str, (r) => String(r.make(Num)))
    expect(() => c.make(Num)).toThrowError(/No binding for "num"/)
    expect(() => c.make(Str)).toThrowError(/No binding for "num" \(needed by "str"\)/)
    try {
      c.make(Num)
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerError)
      expect((error as ContainerError).code).toBe('UNKNOWN_TOKEN')
    }
  })

  test('circular dependencies report the full path', () => {
    const A = token<unknown>('a')
    const B = token<unknown>('b')
    const c = createContainer()
      .singleton(A, (r) => r.make(B))
      .singleton(B, (r) => r.make(A))
    expect(() => c.make(A)).toThrowError('Circular dependency: a -> b -> a')
  })

  test('rebinding a resolved singleton is refused', () => {
    const c = createContainer().singleton(Num, () => 1)
    c.make(Num)
    expect(() => c.value(Num, 2)).toThrowError(
      expect.objectContaining({ code: 'ALREADY_RESOLVED' }),
    )
  })

  test('rebinding before resolution replaces the binding', () => {
    const c = createContainer().value(Num, 1).value(Num, 2)
    expect(c.make(Num)).toBe(2)
  })
})

describe('dispose', () => {
  test('runs cleanups and disposers in reverse order, then refuses use', async () => {
    const order: string[] = []
    const root = createContainer()
      .singleton(Num, () => 1, { dispose: () => void order.push('num') })
      .singleton(Str, () => 's', { dispose: () => void order.push('str') })
    root.onDispose(() => void order.push('first-registered'))
    root.make(Num)
    root.make(Str)
    await root.dispose()
    expect(order).toEqual(['str', 'num', 'first-registered'])
    expect(root.disposed).toBe(true)
    expect(() => root.make(Num)).toThrowError(expect.objectContaining({ code: 'DISPOSED' }))
    expect(() => root.createScope()).toThrow(ContainerError)
    expect(() => root.onDispose(() => undefined)).toThrow(ContainerError)
  })

  test('runs every cleanup even when some fail, and reports all failures together', async () => {
    const ran: string[] = []
    const c = createContainer()
    c.onDispose(() => {
      ran.push('a')
      throw new Error('a failed')
    })
    c.onDispose(async () => {
      ran.push('b')
      throw new Error('b failed')
    })
    c.onDispose(() => void ran.push('c'))
    await expect(c.dispose()).rejects.toSatisfy(
      (e: unknown) => e instanceof AggregateError && e.errors.length === 2,
    )
    expect(ran).toEqual(['c', 'b', 'a'])
  })

  test('is idempotent', async () => {
    const cleanup = vi.fn()
    const c = createContainer()
    c.onDispose(cleanup)
    await c.dispose()
    await c.dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test('scoped instances are disposed with their scope, not the root', async () => {
    const disposed: number[] = []
    let n = 0
    const root = createContainer().scoped(Num, () => ++n, { dispose: (v) => void disposed.push(v) })
    const scope = root.createScope()
    scope.make(Num)
    await scope.dispose()
    expect(disposed).toEqual([1])
    expect(root.disposed).toBe(false)
  })

  test('unresolved services are never created just to be disposed', async () => {
    const factory = vi.fn(() => 1)
    const c = createContainer().singleton(Num, factory, { dispose: () => undefined })
    await c.dispose()
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('resolving after disposal', () => {
  test('a live scope never creates an app-wide singleton in a disposed container', async () => {
    const root = createContainer()
    const dispose = vi.fn()
    let created = 0
    root.singleton(Obj, () => ({ id: ++created }), { dispose })
    const scope = root.createScope() // e.g. a request still in flight during shutdown
    await root.dispose()
    expect(() => scope.make(Obj)).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
    expect(created).toBe(0) // no instance whose cleanup could never run
  })

  test('the same holds for a singleton reached as a dependency, and for scoped services', async () => {
    const root = createContainer()
    root.singleton(Num, () => 1)
    root.bind(Str, (r) => String(r.make(Num)))
    root.scoped(Obj, () => ({ id: 2 }))
    const scope = root.createScope()
    await scope.dispose()
    expect(() => scope.make(Obj)).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
    const other = root.createScope()
    await root.dispose()
    expect(() => other.make(Str)).toThrow(expect.objectContaining({ code: 'DISPOSED' }))
  })
})
