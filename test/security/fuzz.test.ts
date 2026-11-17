/**
 * Fuzz tests for the parsers that face hostile input (ported from spike 12): the JSON limit
 * parser (and its pre-scan), the signed-URL verifier, the open-redirect guard and the
 * forwarded-header reader. A seeded generator keeps every run reproducible; the seed is in the
 * test name, so a failure can be replayed.
 */
import { describe, expect, it } from 'vitest'
import { forwardedClient, resolveTrustProxy } from '../../src/http/proxy.ts'
import { Keyring } from '../../src/security/keyring.ts'
import { safeRedirectTarget } from '../../src/security/redirect.ts'
import { JsonLimitError, measureJson, parseJsonSafely } from '../../src/security/safe-json.ts'
import { UrlSigner } from '../../src/security/signer.ts'

/** mulberry32: a tiny, fast, seeded PRNG (good enough for fuzzing, never for secrets). */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = [
  'a',
  'Z',
  '0',
  ' ',
  '"',
  '\\',
  '{',
  '}',
  '[',
  ']',
  ':',
  ',',
  'é',
  ' ',
  '\n',
  '_',
  'p',
  'r',
  'o',
  't',
]

function randomString(random: () => number, max: number, alphabet = ALPHABET): string {
  return Array.from(
    { length: Math.floor(random() * max) },
    () => alphabet[Math.floor(random() * alphabet.length)] ?? 'a',
  ).join('')
}

/** A random JSON value and its true depth and key count. */
function randomValue(
  random: () => number,
  depth: number,
): { value: unknown; depth: number; keys: number } {
  const roll = random()
  if (depth > 6 || roll < 0.35) {
    const leaves = [
      null,
      true,
      false,
      Math.floor(random() * 1e6) - 5e5,
      random(),
      randomString(random, 8),
    ]
    return { value: leaves[Math.floor(random() * leaves.length)], depth: 0, keys: 0 }
  }
  const children = Array.from({ length: Math.floor(random() * 4) }, () =>
    randomValue(random, depth + 1),
  )
  const childDepth = Math.max(0, ...children.map((child) => child.depth))
  const childKeys = children.reduce((total, child) => total + child.keys, 0)
  if (roll < 0.65)
    return { value: children.map((child) => child.value), depth: childDepth + 1, keys: childKeys }
  const object: Record<string, unknown> = {}
  children.forEach((child, index) => {
    object[`${randomString(random, 5)}#${index}`] = child.value
  })
  return { value: object, depth: childDepth + 1, keys: childKeys + children.length }
}

describe('fuzz: the JSON limit parser', () => {
  it.each([1, 2, 3])(
    'agrees with JSON.parse and measures depth and keys exactly (seed %i, 2,000 values)',
    (seed) => {
      const random = prng(seed)
      for (let round = 0; round < 2000; round++) {
        const { value, depth, keys } = randomValue(random, 0)
        const text = JSON.stringify(value, null, random() < 0.5 ? 0 : 2)
        expect(measureJson(text)).toEqual({ depth, keys })
        expect(parseJsonSafely(text, { maxDepth: 64, maxKeys: 100_000 })).toEqual(JSON.parse(text))
        if (depth > 0)
          expect(() => parseJsonSafely(text, { maxDepth: depth - 1, maxKeys: 100_000 })).toThrow(
            JsonLimitError,
          )
        if (keys > 0)
          expect(() => parseJsonSafely(text, { maxDepth: 64, maxKeys: keys - 1 })).toThrow(
            JsonLimitError,
          )
      }
    },
  )

  it.each([4, 5])(
    'only ever throws JsonLimitError on mutated or random input (seed %i, 5,000 inputs)',
    (seed) => {
      const random = prng(seed)
      for (let round = 0; round < 5000; round++) {
        const base = JSON.stringify(randomValue(random, 0).value) ?? 'null'
        const position = Math.floor(random() * (base.length + 1))
        const text =
          random() < 0.3
            ? randomString(random, 40)
            : `${base.slice(0, position)}${randomString(random, 4)}${base.slice(position + Math.floor(random() * 3))}`
        try {
          parseJsonSafely(text, { maxDepth: 8, maxKeys: 50 })
        } catch (error) {
          expect(error).toBeInstanceOf(JsonLimitError)
        }
      }
    },
  )

  it('never returns an object carrying a __proto__ key, however it is spelled', () => {
    const random = prng(6)
    const spellings = ['__proto__', '\\u005f\\u005fproto\\u005f\\u005f', '__pro\\u0074o__']
    for (let round = 0; round < 500; round++) {
      const nested = JSON.stringify(randomValue(random, 3).value) ?? 'null'
      const key = spellings[round % spellings.length] ?? '__proto__'
      expect(() => parseJsonSafely(`{"a":[${nested},{"${key}":{"polluted":true}}]}`)).toThrow(
        /__proto__/,
      )
    }
    expect(Reflect.get({}, 'polluted')).toBeUndefined()
  })
})

describe('fuzz: the signed-URL verifier', () => {
  const signer = new UrlSigner(Keyring.from(`base64:${Buffer.alloc(32, 7).toString('base64')}`))
  const purpose = 'route:fuzz'
  const now = Date.parse('2026-11-15T10:00:00Z')
  const URL_CHARS = [
    'a',
    'b',
    'Z',
    '0',
    '9',
    '-',
    '_',
    '.',
    '~',
    '%',
    '2',
    'F',
    '/',
    '?',
    '&',
    '=',
    '#',
    '+',
    ' ',
    'é',
  ]

  /** What a URL *means* to the app: its path and its parameters (sorted), signature excluded. */
  function meaning(url: string): string {
    const parsed = new URL(`http://x.invalid${url.startsWith('/') ? url : `/${url}`}`)
    const params = [...parsed.searchParams]
      .filter(([key]) => key !== 'signature')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `${parsed.pathname}?${JSON.stringify(params)}#${parsed.searchParams.getAll('signature').join(',')}`
  }

  it.each([11, 12, 13])(
    'a one-character change is valid only if it changes nothing (seed %i, 3,000 links)',
    (seed) => {
      const random = prng(seed)
      const pick = (): string => URL_CHARS[Math.floor(random() * URL_CHARS.length)] ?? 'a'
      for (let round = 0; round < 3000; round++) {
        const segments = Array.from(
          { length: 1 + Math.floor(random() * 3) },
          () => encodeURIComponent(randomString(random, 6)) || 'x',
        )
        const params = new URLSearchParams(
          Array.from({ length: Math.floor(random() * 3) }, (_, index): [string, string] => [
            `p${index}`,
            randomString(random, 5),
          ]),
        )
        const expiresAt = random() < 0.5 ? now + 3_600_000 : undefined
        const url = signer.sign(
          `/${segments.join('/')}${params.size > 0 ? `?${params.toString()}` : ''}`,
          {
            purpose,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
          },
        )
        expect(signer.verifySync(url, { purpose, now })).toBe('valid')
        const position = Math.floor(random() * url.length)
        const mutated = `${url.slice(0, position)}${pick()}${url.slice(position + 1)}`
        const verdict = signer.verifySync(mutated, { purpose, now })
        if (verdict === 'valid') expect(meaning(mutated), `${url} -> ${mutated}`).toBe(meaning(url))
      }
    },
  )

  it('never throws on arbitrary input (seed 14, 5,000 strings)', async () => {
    const random = prng(14)
    for (let round = 0; round < 5000; round++) {
      const text = `/${randomString(random, 30)}?signature=${randomString(random, 43)}&expires=${randomString(random, 4)}`
      expect(['valid', 'invalid_signature', 'signature_expired']).toContain(
        signer.verifySync(text, { purpose, now }),
      )
    }
    for (let round = 0; round < 500; round++)
      expect(await signer.verify(randomString(random, 60, URL_CHARS), { purpose, now })).toBe(
        'invalid_signature',
      )
  })
})

describe('fuzz: the redirect guard and the forwarded-header reader', () => {
  const CHARS = [
    '/',
    '\\',
    '.',
    '%',
    '2',
    'F',
    '5',
    'C',
    'e',
    ':',
    '@',
    '?',
    '#',
    '\t',
    '\n',
    ' ',
    'a',
    'h',
    't',
    'p',
    's',
  ]

  it('a "safe" redirect target is always a single-slash same-origin path (seed 21, 20,000 inputs)', () => {
    const random = prng(21)
    for (let round = 0; round < 20_000; round++) {
      const candidate = randomString(random, 16, CHARS)
      const safe = safeRedirectTarget(candidate, 'https://blog.example.com')
      if (safe === undefined) continue
      expect(safe.startsWith('/') && !safe.startsWith('//'), candidate).toBe(true)
      expect(new URL(safe, 'https://blog.example.com').origin).toBe('https://blog.example.com')
    }
  })

  it('X-Forwarded-For from an untrusted peer never changes the answer (seed 22, 5,000 headers)', () => {
    const random = prng(22)
    const proxies = resolveTrustProxy(['10.0.0.0/8'])
    const IP_CHARS = ['1', '2', '0', '.', ':', ',', ' ', 'f', 'a', '%', '[', ']']
    for (let round = 0; round < 5000; round++) {
      const header = randomString(random, 40, IP_CHARS)
      const request = new Request('http://localhost/', { headers: { 'x-forwarded-for': header } })
      expect(forwardedClient('198.51.100.9', request, proxies).ip).toBe('198.51.100.9')
      const trusted = forwardedClient('10.0.0.5', request, proxies).ip
      expect(trusted === undefined || typeof trusted === 'string').toBe(true)
    }
  })
})
