import fc from 'fast-check'
import { describe, expect, test, vi } from 'vitest'
import {
  createLogger,
  createTestClock,
  createUuidV7Generator,
  isoNow,
  isUuidV7,
  REDACTED,
  runWithContext,
  sensitiveKeyMatcher,
  serializeError,
  systemClock,
  toLoggable,
  uuidV7Timestamp,
  uuidv7,
} from '../../src/core/index.ts'

const capture = () => {
  const lines: string[] = []
  return {
    lines,
    sink: (l: string) => void lines.push(l),
    records: () => lines.map((l) => JSON.parse(l)),
  }
}

describe('createLogger', () => {
  const clock = createTestClock(Date.UTC(2026, 10, 14, 9, 30))

  test('writes one JSON line per call with time, level, msg and fields', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink, clock, bindings: { service: 'api' } })
    log.info('Invoice sent', { invoiceId: 'inv-1' })
    expect(out.records()).toEqual([
      {
        time: '2026-11-14T09:30:00.000Z',
        level: 'info',
        msg: 'Invoice sent',
        fields: { service: 'api', invoiceId: 'inv-1' },
      },
    ])
  })

  test('filters by level and reports isLevelEnabled', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink, level: 'warn' })
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    log.fatal('f')
    expect(out.records().map((r) => r.level)).toEqual(['warn', 'error', 'fatal'])
    expect(log.isLevelEnabled('info')).toBe(false)
    expect(log.isLevelEnabled('error')).toBe(true)
    expect(() => createLogger({ level: 'verbose' as never })).toThrow(RangeError)
  })

  test('child loggers add bindings without affecting the parent', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink })
    log.child({ module: 'billing' }).child({ step: 2 }).info('x')
    log.info('y')
    expect(out.records().map((r) => r.fields)).toEqual([{ module: 'billing', step: 2 }, undefined])
  })

  test('enriches from the request context', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink })
    runWithContext(
      {
        requestId: 'r1',
        traceId: 't1',
        tenant: { id: 'ten-1', strategy: 'shared' },
        actor: { id: 'u1', type: 'user', roles: [], attrs: {} },
      },
      () => log.info('in request'),
    )
    expect(out.records()[0]).toMatchObject({
      requestId: 'r1',
      traceId: 't1',
      tenantId: 'ten-1',
      actorId: 'u1',
    })
  })

  test('redacts sensitive keys at any depth (built-in and custom)', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink, redactKeys: ['iban'] })
    log.info('login', {
      user: 'ann',
      password: 'hunter2',
      headers: { Authorization: 'Bearer abc', 'set-cookie': 's=1' },
      payment: { IBAN: 'DE00', apiKey: 'k' },
    })
    const line = out.lines[0] ?? ''
    for (const secret of ['hunter2', 'Bearer abc', 's=1', 'DE00', '"k"'])
      expect(line).not.toContain(secret)
    expect(out.records()[0].fields.headers.Authorization).toBe(REDACTED)
  })

  test('errors are serialised with stack and cause chain', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink })
    const err = Object.assign(
      new Error('payment failed', { cause: new TypeError('card declined') }),
      { code: 'E_PAY' },
    )
    log.error('charge failed', { err, orderId: 1 })
    log.error('alt key', { error: new Error('x') })
    const [first, second] = out.records()
    expect(first.err).toMatchObject({
      name: 'Error',
      message: 'payment failed',
      code: 'E_PAY',
      cause: { name: 'TypeError', message: 'card declined' },
    })
    expect(first.err.stack).toContain('payment failed')
    expect(first.fields).toEqual({ orderId: 1 })
    expect(second.err.message).toBe('x')
  })

  test('one call = one line, even with CR/LF/ANSI/U+2028 in the message', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink })
    const ch = (code: number): string => String.fromCharCode(code)
    const controls = [ch(0x0d), ch(0x0a), ch(0x2028), ch(0x2029), ch(0x1b)]
    const evil = `line1${ch(0x0d)}${ch(0x0a)}line2${ch(0x1b)}[31m red ${ch(0x2028)} sep ${ch(0x2029)} end`
    log.info(evil)
    expect(out.lines).toHaveLength(1)
    const line = out.lines[0] ?? ''
    for (const c of controls) expect(line.includes(c)).toBe(false)
    expect(JSON.parse(line).msg).toBe(evil)
  })

  test('NEVER throws: a failing sink warns once and counts drops', () => {
    const warn = vi.fn()
    const log = createLogger({
      sink: () => {
        throw new Error('disk full')
      },
      warn,
    })
    expect(() => {
      log.info('a')
      log.child({ x: 1 }).error('b')
    }).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('disk full')
    expect(log.dropped).toBe(2)
  })

  test('never throws even when the warning channel and the context provider fail', () => {
    const log = createLogger({
      sink: () => {
        throw new Error('x')
      },
      warn: () => {
        throw new Error('stderr broken')
      },
      context: () => {
        throw new Error('ctx broken')
      },
    })
    expect(() => log.info('a')).not.toThrow()
    const out = capture()
    const ok = createLogger({
      sink: out.sink,
      context: () => {
        throw new Error('ctx broken')
      },
    })
    ok.info('still logs')
    expect(out.records()[0].msg).toBe('still logs')
  })

  test('handles hostile field values without throwing', () => {
    const out = capture()
    const log = createLogger({ sink: out.sink })
    const circular: { a: number; self?: unknown } = { a: 1 }
    circular.self = circular
    log.info(42 as unknown as string, {
      circular,
      big: 10n,
      fn: () => 1,
      sym: Symbol('s'),
      nan: Number.NaN,
    })
    const r = out.records()[0]
    expect(r.msg).toBe('42')
    expect(r.fields).toEqual({ circular: { a: 1, self: '[Circular]' }, big: '10', nan: 'NaN' })
  })

  test('flush is a no-op without an async sink and is bounded with one', async () => {
    await expect(createLogger().flush()).resolves.toBeUndefined()
    const slow = createLogger({ flush: () => new Promise(() => undefined), flushTimeoutMs: 20 })
    const start = Date.now()
    await slow.flush()
    expect(Date.now() - start).toBeLessThan(1000)
    const failing = createLogger({
      flush: async () => {
        throw new Error('x')
      },
    })
    await expect(failing.flush()).resolves.toBeUndefined()
  })

  test('the default sink writes to stdout with a newline', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    createLogger().info('to stdout')
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/"msg":"to stdout"\}\n$/)
    spy.mockRestore()
  })

  test('the default warning goes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    createLogger({
      sink: () => {
        throw new Error('boom')
      },
    }).info('x')
    expect(String(spy.mock.calls[0]?.[0])).toContain('logger sink failed')
    spy.mockRestore()
  })
})

interface LoggableSample {
  d: unknown
  bad: unknown
  m: unknown
  s: unknown
  b: unknown
  long: unknown
  arr: unknown[]
  inf: unknown
}

describe('toLoggable / serializeError', () => {
  test('dates, maps, sets, typed arrays, arrays and truncation', () => {
    const out = toLoggable({
      d: new Date('2026-11-14T00:00:00Z'),
      bad: new Date(Number.NaN),
      m: new Map([['k', 1]]),
      s: new Set([1, 2]),
      b: new Uint8Array(4),
      long: 'x'.repeat(9000),
      arr: Array.from({ length: 105 }, (_, i) => i),
      inf: Number.POSITIVE_INFINITY,
      u: undefined,
    }) as LoggableSample
    expect(out.d).toBe('2026-11-14T00:00:00.000Z')
    expect(out.bad).toBe('Invalid Date')
    expect(out.m).toEqual({ k: 1 })
    expect(out.s).toEqual([1, 2])
    expect(out.b).toBe('[Uint8Array(4 bytes)]')
    expect(String(out.long)).toContain('[truncated 808 chars]')
    expect(out.arr.at(-1)).toBe('…[5 more]')
    expect(out.inf).toBe('Infinity')
    expect('u' in out).toBe(false)
  })

  test('depth limit, unreadable getters and shared (non-circular) references', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 12; i++) deep = { next: deep }
    expect(JSON.stringify(toLoggable(deep))).toContain('[Depth limit]')
    const tricky = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter')
      },
    })
    expect(toLoggable(tricky)).toEqual({ boom: '[Unreadable]' })
    const shared = { v: 1 }
    expect(toLoggable({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } })
    expect(toLoggable([undefined, () => 1])).toEqual([null, null])
  })

  test('sensitiveKeyMatcher ignores case, dashes and underscores', () => {
    const m = sensitiveKeyMatcher()
    for (const k of [
      'Password',
      'access_token',
      'X-API-Key',
      'set-cookie',
      'clientSecret',
      'private_key',
    ])
      expect(m(k)).toBe(true)
    for (const k of ['user', 'amount', 'tokenizerVersionX'.replace('token', 'tok')])
      expect(m(k)).toBe(false)
  })

  test('serializeError limits the cause chain depth', () => {
    let e = new Error('root')
    for (let i = 0; i < 10; i++) e = new Error(`level ${i}`, { cause: e })
    let depth = 0
    for (let c = serializeError(e); c.cause; c = c.cause) depth++
    expect(depth).toBe(5)
  })
})

describe('uuidv7', () => {
  test('format, version, variant and embedded timestamp', () => {
    const clock = createTestClock(Date.UTC(2026, 10, 14))
    const gen = createUuidV7Generator({ clock })
    const id = gen()
    expect(isUuidV7(id)).toBe(true)
    expect(uuidV7Timestamp(id)).toBe(Date.UTC(2026, 10, 14))
    expect(isUuidV7(uuidv7())).toBe(true)
    expect(() => uuidV7Timestamp('not-a-uuid')).toThrow(TypeError)
  })

  test('strictly increasing within the same millisecond and across a backwards clock step', () => {
    const clock = createTestClock(Date.UTC(2026, 10, 14))
    const gen = createUuidV7Generator({ clock })
    const ids: string[] = []
    for (let i = 0; i < 5000; i++) ids.push(gen()) // forces counter overflow into the next ms
    clock.set(Date.UTC(2026, 10, 13)) // clock steps back a day
    ids.push(gen(), gen())
    for (let i = 1; i < ids.length; i++)
      expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('rejects an invalid clock', () => {
    const gen = createUuidV7Generator({ clock: { now: () => Number.NaN } })
    expect(() => gen()).toThrow(RangeError)
  })

  test('PROPERTY: ids from increasing timestamps sort in timestamp order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2 ** 40 }), { minLength: 2, maxLength: 50 }),
        (times) => {
          const sorted = [...times].sort((a, b) => a - b)
          let i = 0
          const gen = createUuidV7Generator({ clock: { now: () => sorted[i++] as number } })
          const ids = sorted.map(() => gen())
          return ids.every((id, j) => j === 0 || id > (ids[j - 1] as string))
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('clock', () => {
  test('TestClock advances and sets; rejects invalid input', () => {
    const c = createTestClock(1000)
    c.advance(500)
    expect(c.now()).toBe(1500)
    c.set(10)
    expect(c.now()).toBe(10)
    expect(() => c.advance(-1)).toThrow(RangeError)
    expect(() => c.set(Number.NaN)).toThrow(RangeError)
    expect(() => createTestClock(Number.NaN)).toThrow(RangeError)
    expect(isoNow(c)).toBe('1970-01-01T00:00:00.010Z')
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1000)
    expect(isoNow()).toMatch(/^\d{4}-/)
  })
})

describe('own keys that collide with Object.prototype', () => {
  test('a logged object with an own "__proto__" key keeps its data and redaction', () => {
    const value = JSON.parse('{"__proto__": {"note": "kept", "password": "pw-canary"}, "x": 1}')
    const out = toLoggable(value) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    const line = JSON.stringify(out)
    expect(line).toContain('"note":"kept"')
    expect(line).not.toContain('pw-canary')
    expect(JSON.parse(line)).toEqual(
      JSON.parse('{"__proto__": {"note": "kept", "password": "[REDACTED]"}, "x": 1}'),
    )
  })

  test('the logger writes such fields instead of dropping them', () => {
    const lines: string[] = []
    const logger = createLogger({ sink: (l) => lines.push(l) })
    logger.info('m', JSON.parse('{"__proto__": {"a": 1}}'))
    expect(lines[0]).toContain('"__proto__":{"a":1}')
  })
})
