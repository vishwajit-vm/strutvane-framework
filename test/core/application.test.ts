import { describe, expect, test, vi } from 'vitest'
import type { Logger } from '../../src/contracts/index.ts'
import {
  ClockToken,
  createApp,
  createTestClock,
  defineProvider,
  ErrorRegistryToken,
  EventBusToken,
  HooksToken,
  IdGeneratorToken,
  isUuidV7,
  LoggerToken,
  MessagesToken,
  ProviderError,
  token,
} from '../../src/core/index.ts'

const config = { app: { name: 'acme' }, database: { default: 'postgres', pool: { max: 10 } } }

describe('createApp', () => {
  test('rejects duplicate and unnamed providers', () => {
    const p = defineProvider({ name: 'x', register: () => undefined })
    expect(() => createApp({ config, providers: [p, p] })).toThrow(/Duplicate provider "x"/)
    expect(() =>
      createApp({ config, providers: [{ name: '', register: () => undefined }] }),
    ).toThrow(TypeError)
  })

  test('exposes deep-frozen settings and typed config paths', () => {
    const app = createApp({ config })
    expect(app.config('database.pool.max')).toBe(10)
    expect(Object.isFrozen(app.settings.database.pool)).toBe(true)
    expect(() => app.config('database.nope' as never)).toThrow(/does not exist/)
  })

  test('binds default services that work out of the box', () => {
    const clock = createTestClock()
    const app = createApp({ config, clock })
    expect(app.make(ClockToken)).toBe(clock)
    expect(isUuidV7(app.make(IdGeneratorToken)())).toBe(true)
    expect(app.make(MessagesToken).format('errors.not_found.title')).toBe('Not found')
    expect(app.make(ErrorRegistryToken).get('not_found')?.status).toBe(404)
    expect(app.make(EventBusToken).listenerCount('x')).toBe(0)
    expect(app.make(HooksToken).order('x')).toEqual([])
    expect(typeof app.make(LoggerToken).info).toBe('function')
  })
})

describe('lifecycle', () => {
  test('registers all, then boots in order; shuts down in reverse order', async () => {
    const order: string[] = []
    const mk = (name: string) =>
      defineProvider({
        name,
        register: () => void order.push(`register:${name}`),
        boot: async () => void order.push(`boot:${name}`),
        shutdown: async () => void order.push(`shutdown:${name}`),
      })
    const app = createApp({ config, providers: [mk('a'), mk('b')] })
    expect(app.state).toBe('created')
    await app.boot()
    expect(app.state).toBe('booted')
    const report = await app.shutdown()
    expect(report).toEqual({ timedOut: false, errors: [] })
    expect(app.state).toBe('stopped')
    expect(order).toEqual([
      'register:a',
      'register:b',
      'boot:a',
      'boot:b',
      'shutdown:b',
      'shutdown:a',
    ])
  })

  test('a provider can replace a default service (e.g. @strutvane/logs rebinding the logger)', async () => {
    const custom = { info: vi.fn() } as unknown as Logger
    const app = createApp({
      config,
      providers: [
        defineProvider({
          name: 'logs',
          register: (a) => void a.container.value(LoggerToken, custom),
        }),
      ],
    })
    await app.boot()
    expect(app.make(LoggerToken)).toBe(custom)
  })

  test('providers share services through the container', async () => {
    const Greeting = token<string>('greeting')
    let seen = ''
    const app = createApp({
      config,
      providers: [
        defineProvider({ name: 'one', register: (a) => void a.container.value(Greeting, 'hello') }),
        defineProvider<typeof config>({
          name: 'two',
          register: () => undefined,
          boot: (a) => {
            seen = `${a.make(Greeting)} ${a.config('app.name')}`
          },
        }),
      ],
    })
    await app.boot()
    expect(seen).toBe('hello acme')
  })

  test('register failures name the provider and fail the app', async () => {
    const app = createApp({
      config,
      providers: [
        defineProvider({
          name: 'broken',
          register: () => {
            throw new Error('bad binding')
          },
        }),
      ],
    })
    await expect(app.boot()).rejects.toThrowError(
      /Provider "broken" failed during register: bad binding/,
    )
    expect(app.state).toBe('failed')
    await expect(app.boot()).rejects.toThrow(/state "failed"/)
  })

  test('asynchronous register() is rejected with a helpful message', async () => {
    const app = createApp({
      config,
      providers: [{ name: 'async', register: (async () => undefined) as unknown as () => void }],
    })
    await expect(app.boot()).rejects.toThrow(/must be synchronous/)
  })

  test('boot failure: providers that already booted are still shut down', async () => {
    const stopped: string[] = []
    const app = createApp({
      config,
      providers: [
        defineProvider({
          name: 'ok',
          register: () => undefined,
          shutdown: () => void stopped.push('ok'),
        }),
        defineProvider({
          name: 'fails',
          register: () => undefined,
          boot: () => {
            throw new Error('db down')
          },
          shutdown: () => void stopped.push('fails'),
        }),
      ],
    })
    const error = await app.boot().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).provider).toBe('fails')
    expect((error as ProviderError).phase).toBe('boot')
    await app.shutdown()
    expect(stopped).toEqual(['ok'])
  })

  test('a hanging provider cannot block shutdown beyond the timeout', async () => {
    const app = createApp({
      config,
      providers: [
        defineProvider({
          name: 'hangs',
          register: () => undefined,
          shutdown: () => new Promise<void>(() => undefined),
        }),
      ],
    })
    await app.boot()
    const started = Date.now()
    const report = await app.shutdown({ timeoutMs: 50 })
    expect(report.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(app.state).toBe('stopped')
  })

  test('shutdown collects every failure and keeps going', async () => {
    const stopped: string[] = []
    const app = createApp({
      config,
      providers: [
        defineProvider({
          name: 'a',
          register: () => undefined,
          shutdown: () => void stopped.push('a'),
        }),
        defineProvider({
          name: 'b',
          register: () => undefined,
          shutdown: () => {
            throw new Error('flush failed')
          },
        }),
      ],
    })
    await app.boot()
    app.container.onDispose(() => {
      throw new Error('cleanup failed')
    })
    const report = await app.shutdown()
    expect(stopped).toEqual(['a'])
    expect(report.errors.map((e) => e.provider)).toEqual(['b', 'container'])
  })

  test('shutdown is idempotent and safe before boot', async () => {
    const app = createApp({ config })
    const [r1, r2] = await Promise.all([app.shutdown(), app.shutdown()])
    expect(r1).toBe(r2)
    expect(r1.timedOut).toBe(false)
  })

  test('rejects invalid timeouts', async () => {
    const app = createApp({ config })
    await expect(app.shutdown({ timeoutMs: -1 })).rejects.toThrow(RangeError)
  })
})
