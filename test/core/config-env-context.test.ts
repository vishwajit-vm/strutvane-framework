import type { StandardSchemaV1 } from '@strutvane/contracts'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  currentContext,
  deepFreeze,
  defineConfig,
  defineEnv,
  EnvValidationError,
  getConfigValue,
  runWithContext,
} from '../src/index.ts'

describe('config', () => {
  test('defineConfig deep-freezes, including arrays and nested objects', () => {
    const c = defineConfig({ a: { b: [1, { c: 2 }] } })
    expect(Object.isFrozen(c.a.b)).toBe(true)
    expect(Object.isFrozen(c.a.b[1])).toBe(true)
    expect(() => {
      ;(c.a as { b: unknown }).b = 1
    }).toThrow(TypeError)
  })

  test('deepFreeze handles cycles and primitives', () => {
    const a: { self?: unknown } = {}
    a.self = a
    expect(deepFreeze(a)).toBe(a)
    expect(Object.isFrozen(a)).toBe(true)
    expect(deepFreeze(5)).toBe(5)
  })

  test('getConfigValue reads nested values and fails closed on missing paths', () => {
    const c = { db: { url: 'x', opts: { ssl: false } } }
    expect(getConfigValue(c, 'db.opts.ssl')).toBe(false)
    expect(() => getConfigValue(c, 'db.opts.nope' as never)).toThrow('missing "db.opts.nope"')
    expect(() => getConfigValue(c, 'db.url.length' as never)).toThrow(RangeError)
  })
})

describe('env', () => {
  const schema = z.object({
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().int().default(3000),
    API_SECRET: z.string().min(32),
  })

  test('returns a typed, frozen result with defaults and coercion', () => {
    const env = defineEnv(schema, {
      DATABASE_URL: 'postgres://x',
      API_SECRET: 'x'.repeat(32),
      PORT: '8080',
    })
    expect(env.PORT).toBe(8080)
    expect(Object.isFrozen(env)).toBe(true)
    expect(defineEnv(schema, { DATABASE_URL: 'p', API_SECRET: 'y'.repeat(32) }).PORT).toBe(3000)
  })

  test('reports EVERY problem at once, sorted, and never prints values', () => {
    const secret = 'too-short-secret-value'
    let error: unknown
    try {
      defineEnv(schema, { API_SECRET: secret, PORT: 'abc' })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(EnvValidationError)
    const e = error as EnvValidationError
    expect(e.problems.map((p) => p.key)).toEqual(['API_SECRET', 'DATABASE_URL', 'PORT'])
    expect(e.message).toContain('3 problem(s)')
    expect(e.message).toContain('.env.example')
    expect(e.message).not.toContain(secret)
    expect(e.message).not.toContain('abc')
  })

  test('rejects non-Standard-Schema inputs and async validators', () => {
    expect(() => defineEnv({} as never)).toThrow(/Standard Schema/)
    const asyncSchema: StandardSchemaV1<unknown, { a: string }> = {
      '~standard': { version: 1, vendor: 'test', validate: async () => ({ value: { a: 'x' } }) },
    }
    expect(() => defineEnv(asyncSchema, {})).toThrow(/asynchronous validators/)
  })

  test('handles root-level issues and object path segments', () => {
    const custom: StandardSchemaV1<unknown, never> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({
          issues: [{ message: 'bad root' }, { message: 'bad', path: [{ key: 'NESTED' }, 'X'] }],
        }),
      },
    }
    try {
      defineEnv(custom, {})
    } catch (e) {
      expect((e as EnvValidationError).problems).toEqual([
        { key: '', message: 'bad root' },
        { key: 'NESTED.X', message: 'bad' },
      ])
      expect((e as Error).message).toContain('(root): bad root')
    }
    expect.assertions(2)
  })

  test('does not let the validator mutate the source', () => {
    const source: { DATABASE_URL: string; API_SECRET: string; INJECTED?: string } = {
      DATABASE_URL: 'p',
      API_SECRET: 'z'.repeat(32),
    }
    const mutating: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 't',
        validate: (v) => {
          ;(v as { INJECTED?: string }).INJECTED = '1'
          return { value: v }
        },
      },
    }
    defineEnv(mutating, source)
    expect(source.INJECTED).toBeUndefined()
  })
})

describe('request context', () => {
  test('is undefined outside a run and isolated between concurrent runs', async () => {
    expect(currentContext()).toBeUndefined()
    const seen: (string | undefined)[] = []
    await Promise.all(
      ['a', 'b'].map((id) =>
        runWithContext({ requestId: id }, async () => {
          await new Promise((r) => setTimeout(r, id === 'a' ? 10 : 1))
          seen.push(currentContext()?.requestId)
        }),
      ),
    )
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  test('nested runs inherit and override, merging extras', () => {
    runWithContext({ requestId: 'r1', locale: 'en', extras: { a: 1 } }, () => {
      runWithContext({ locale: 'hi', extras: { b: 2 } }, () => {
        const ctx = currentContext()
        expect(ctx?.requestId).toBe('r1')
        expect(ctx?.locale).toBe('hi')
        expect(ctx?.extras).toEqual({ a: 1, b: 2 })
        expect(Object.isFrozen(ctx)).toBe(true)
      })
      expect(currentContext()?.locale).toBe('en')
    })
  })

  test('nested runs without extras keep the context free of an extras key', () => {
    runWithContext({ requestId: 'x' }, () => {
      runWithContext({ traceId: 't' }, () => {
        expect(currentContext()).toEqual({ requestId: 'x', traceId: 't' })
      })
    })
  })
})
