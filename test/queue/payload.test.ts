/**
 * Job payloads (RFC-0006 §2): plain data only, no secrets, size and depth caps, and a signature
 * over every field so an edited row is refused instead of run.
 */
import { describe, expect, test } from 'vitest'
import { isQueueError, QueueError } from '../../src/queue/errors.ts'
import {
  assertPlainData,
  canonicalJson,
  DEFAULT_MAX_PAYLOAD_BYTES,
  type Envelope,
  EnvelopeSigner,
} from '../../src/queue/payload.ts'
import { signingKey } from './support.ts'

const envelope: Envelope = {
  v: 1,
  id: '0193a000-0000-7000-8000-000000000001',
  job: 'send-mail',
  data: { userId: 'u1', tags: ['a', 'b'], n: 3, ok: true, none: null },
  queue: 'default',
  connection: 'main',
  dispatchedAt: 1_767_225_600_000,
  tries: 3,
  backoff: [10, 60],
  timeout: 60,
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return isQueueError(error) ? error.code : `not a queue error: ${String(error)}`
  }
  return undefined
}

describe('assertPlainData', () => {
  test('accepts plain JSON data, including null-prototype objects', () => {
    const bare = Object.assign(Object.create(null) as object, { a: 1 })
    expect(assertPlainData({ a: [1, 'x', true, null, { b: 2.5 }], bare })).toBeTruthy()
  })

  test.each([
    ['a Date', { at: new Date() }, 'data.at'],
    ['a Map', { m: new Map() }, 'data.m'],
    ['a class instance', { x: new (class Model {})() }, 'data.x'],
    ['a function', { f: () => 1 }, 'data.f'],
    ['a symbol', { s: Symbol('x') }, 'data.s'],
    ['a bigint', { b: 1n }, 'data.b'],
    ['undefined', { list: [undefined] }, 'data.list[0]'],
    ['NaN', { n: Number.NaN }, 'data.n'],
    ['Infinity', { n: Number.POSITIVE_INFINITY }, 'data.n'],
  ])('refuses %s and names the path', (_what, value, path) => {
    let error: unknown
    try {
      assertPlainData(value)
    } catch (caught) {
      error = caught
    }
    expect(isQueueError(error) && error.code).toBe('queue_payload_not_plain')
    expect(String((error as Error).message)).toContain(path)
  })

  test('refuses cycles and very deep nesting', () => {
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    expect(codeOf(() => assertPlainData(cycle))).toBe('queue_payload_not_plain')
    let deep: unknown = 1
    for (let i = 0; i < 40; i++) deep = [deep]
    expect(codeOf(() => assertPlainData(deep))).toBe('queue_payload_not_plain')
  })

  test('allows the same object twice when it is not a cycle', () => {
    const shared = { a: 1 }
    expect(assertPlainData({ x: shared, y: shared })).toBeTruthy()
  })

  test.each(['__proto__', 'constructor', 'prototype'])('refuses the reserved key %s', (key) => {
    const value = JSON.parse(`{"${key}": {"polluted": true}}`) as unknown
    expect(codeOf(() => assertPlainData(value))).toBe('queue_payload_not_plain')
  })

  test.each(['password', 'apiKey', 'accessToken', 'client_secret', 'nested.authorization'])(
    'refuses secret-looking keys such as %s',
    (path) => {
      const parts = path.split('.')
      const value = parts.reduceRight<unknown>((inner, key) => ({ [key]: inner }), 'x')
      expect(codeOf(() => assertPlainData(value))).toBe('queue_payload_sensitive')
    },
  )
})

describe('canonicalJson', () => {
  test('sorts keys recursively and drops undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    )
  })
})

describe('EnvelopeSigner', () => {
  test('round-trips an envelope', () => {
    const signer = new EnvelopeSigner([signingKey()])
    expect(signer.decode(signer.encode(envelope))).toEqual(envelope)
  })

  test('verifies even when a store reorders the keys (MySQL JSON, jsonb)', () => {
    const signer = new EnvelopeSigner([signingKey()])
    const parsed = JSON.parse(signer.encode(envelope)) as Record<string, unknown>
    const reordered = Object.fromEntries(Object.entries(parsed).reverse())
    expect(signer.decode(JSON.stringify(reordered))).toEqual(envelope)
  })

  test.each([
    ['the data', (e: Record<string, unknown>) => ({ ...e, data: { userId: 'u2' } })],
    ['the job name', (e: Record<string, unknown>) => ({ ...e, job: 'drop-database' })],
    [
      'the tenant',
      (e: Record<string, unknown>) => ({ ...e, tenantId: '00000000-0000-4000-8000-000000000000' }),
    ],
    ['the tries', (e: Record<string, unknown>) => ({ ...e, tries: 1000 })],
    ['the signature', (e: Record<string, unknown>) => ({ ...e, sig: 'AAAA' })],
    [
      'a removed signature',
      (e: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'sig')),
    ],
  ])('refuses an envelope whose %s was edited', (_what, edit) => {
    const signer = new EnvelopeSigner([signingKey()])
    const stored = JSON.parse(signer.encode(envelope)) as Record<string, unknown>
    expect(codeOf(() => signer.decode(JSON.stringify(edit(stored))))).toBe('queue_payload_tampered')
  })

  test.each([
    ['not JSON', 'not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a signed non-envelope', ''],
  ])('refuses %s', (what, text) => {
    const signer = new EnvelopeSigner([signingKey()])
    const payload =
      what === 'a signed non-envelope'
        ? signer.encode({ ...envelope, tries: 1.5 } as unknown as Envelope)
        : text
    expect(codeOf(() => signer.decode(payload))).toBe('queue_payload_tampered')
  })

  test('a __proto__ key added to a stored row breaks the signature instead of polluting', () => {
    const signer = new EnvelopeSigner([signingKey()])
    const text = signer
      .encode(envelope)
      .replace('"data":{', '"data":{"__proto__":{"isAdmin":true},')
    expect(codeOf(() => signer.decode(text))).toBe('queue_payload_tampered')
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined()
  })

  test('jobs signed with a previous key still verify after a key rotation; others do not', () => {
    const old = signingKey()
    const oldSigner = new EnvelopeSigner([old])
    const rotated = new EnvelopeSigner([signingKey(), old])
    const stranger = new EnvelopeSigner([signingKey()])
    const text = oldSigner.encode(envelope)
    expect(rotated.decode(text)).toEqual(envelope)
    expect(codeOf(() => stranger.decode(text))).toBe('queue_payload_tampered')
  })

  test('refuses payloads above the limit, with a hint', () => {
    const signer = new EnvelopeSigner([signingKey()])
    expect(signer.maxPayloadBytes).toBe(DEFAULT_MAX_PAYLOAD_BYTES)
    const big = { ...envelope, data: { text: 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES) } }
    let error: unknown
    try {
      signer.encode(big)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(QueueError)
    expect((error as QueueError).code).toBe('queue_payload_too_large')
    expect((error as QueueError).describe()).toContain('→')
  })

  test('validates its options', () => {
    expect(codeOf(() => new EnvelopeSigner([]))).toBe('queue_not_configured')
    expect(codeOf(() => new EnvelopeSigner([new Uint8Array(8)]))).toBe('queue_not_configured')
    expect(codeOf(() => new EnvelopeSigner([signingKey()], { maxPayloadBytes: 10 }))).toBe(
      'queue_invalid_option',
    )
    expect(new EnvelopeSigner([signingKey()], { maxPayloadBytes: 200_000 }).maxPayloadBytes).toBe(
      200_000,
    )
  })
})
