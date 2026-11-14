// Type-level tests: misuse must fail to compile.

import { describe, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import type { Logger } from '../../src/contracts/index.ts'
import {
  createApp,
  createContainer,
  createEventBus,
  createHooks,
  defineConfig,
  defineEnv,
  defineProvider,
  LoggerToken,
  token,
} from '../../src/core/index.ts'

describe('container tokens', () => {
  test('make() returns the token type', () => {
    const Port = token<number>('port')
    const c = createContainer().value(Port, 3000)
    expectTypeOf(c.make(Port)).toEqualTypeOf<number>()
    expectTypeOf(c.make(LoggerToken)).toEqualTypeOf<Logger>()
  })

  test('binding a wrong type to a token fails to compile', () => {
    const Port = token<number>('port')
    // @ts-expect-error a string is not a number
    createContainer().value(Port, '3000')
    // @ts-expect-error the factory must return a number
    createContainer().singleton(Port, () => 'x')
  })
})

describe('config paths', () => {
  test('valid paths are typed; invalid paths fail to compile', () => {
    const app = createApp({ config: { database: { default: 'postgres', pool: { max: 10 } } } })
    expectTypeOf(app.config('database.pool.max')).toEqualTypeOf<10>()
    expectTypeOf(app.config('database.default')).toEqualTypeOf<'postgres'>()
    // @ts-expect-error "database.nope" is not a config path
    app.config('database.nope')
  })

  test('defineConfig returns a deeply readonly object', () => {
    const c = defineConfig({ a: { b: 1 } })
    // @ts-expect-error config is readonly
    c.a.b = 2
  })
})

describe('env', () => {
  test('infers the validated type', () => {
    const env = defineEnv(z.object({ PORT: z.coerce.number() }), { PORT: '1' })
    expectTypeOf(env.PORT).toEqualTypeOf<number>()
  })

  test('a non-Standard-Schema value fails to compile', () => {
    // @ts-expect-error a plain object is not a Standard Schema validator
    defineEnv({ PORT: 'number' })
  })
})

describe('hooks and events', () => {
  test('payload types are enforced', async () => {
    const hooks = createHooks<{ save: { id: string } }>()
    // @ts-expect-error unknown hook name
    hooks.on('nope', () => undefined, { name: 'x' })
    // @ts-expect-error wrong payload type
    await hooks.run('save', { id: 1 })
    const bus = createEventBus<{ 'invoice.sent': { id: string } }>()
    bus.on('invoice.sent', (e) => {
      expectTypeOf(e.payload).toEqualTypeOf<{ id: string }>()
      expectTypeOf(e.type).toEqualTypeOf<'invoice.sent'>()
    })
    // @ts-expect-error wrong payload
    await bus.emit('invoice.sent', { id: 1 })
  })
})

describe('providers', () => {
  test('a reusable package provider (Provider<object>) works in any app and sees config as unknown', () => {
    const pkg = defineProvider({
      name: '@acme/pkg',
      register: (app) => {
        expectTypeOf(app.config('anything.at.all')).toEqualTypeOf<unknown>()
      },
    })
    createApp({ config: { a: 1 }, providers: [pkg] })
    createApp({ config: { b: 'x' }, providers: [pkg] })
  })

  test('an app-specific provider gets typed config and is rejected by a different app', () => {
    const appProvider = defineProvider<{ db: { url: string } }>({
      name: 'app',
      register: (app) => {
        expectTypeOf(app.config('db.url')).toEqualTypeOf<string>()
        // @ts-expect-error not a config path of this app
        app.config('db.nope')
      },
    })
    createApp({ config: { db: { url: 'x' } }, providers: [appProvider] })
    // @ts-expect-error this app has no "db.url" config
    createApp({ config: { other: true }, providers: [appProvider] })
  })
})
