/**
 * Prototype-pollution-safe JSON with depth and key limits. Attack-style cases: `__proto__` in
 * every spelling and position, `constructor.prototype`, million-level nesting and key floods
 * refused by the pre-scan before `JSON.parse` runs.
 */
import { describe, expect, it } from 'vitest'
import { StrutvaneError } from '../../src/core/errors/errors.ts'
import {
  DEFAULT_BODY_LIMITS,
  JsonLimitError,
  measureJson,
  parseJsonSafely,
  resolveLimits,
} from '../../src/security/safe-json.ts'

function failure(text: string, limits = DEFAULT_BODY_LIMITS): JsonLimitError {
  try {
    parseJsonSafely(text, limits)
  } catch (error) {
    if (error instanceof JsonLimitError) return error
    throw error
  }
  throw new Error(`Expected ${text.slice(0, 40)} to be refused`)
}

describe('parseJsonSafely', () => {
  it('parses ordinary JSON, including a plain "constructor" field', () => {
    expect(parseJsonSafely('{"title":"Hi","tags":["a"]}')).toEqual({ title: 'Hi', tags: ['a'] })
    expect(parseJsonSafely('{"constructor":"Acme Builders"}')).toEqual({
      constructor: 'Acme Builders',
    })
    expect(parseJsonSafely('{"constructor":{"name":"x"}}')).toEqual({ constructor: { name: 'x' } })
    expect(parseJsonSafely('"[[[[{{{"')).toBe('[[[[{{{')
  })

  it.each([
    '{"__proto__":{"isAdmin":true}}',
    '{"a":[{"b":{"__proto__":{"x":1}}}]}',
    '{"\\u005f_proto__":{"x":1}}',
    '{"__pro\\u0074o__":1}',
    '[{"__proto__":null}]',
    '{"constructor":{"prototype":{"isAdmin":true}}}',
    '{"a":{"constructor":{"prototype":{}}}}',
  ])('refuses %s, and nothing is polluted', (payload) => {
    const error = failure(payload)
    expect(error.code).toBe('forbidden_json_key')
    expect(error.toHttpError().status).toBe(400)
    expect(Reflect.get({}, 'isAdmin')).toBeUndefined()
  })

  it('refuses deep and key-heavy JSON before parsing it (413)', () => {
    const deep = failure(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)
    expect(deep.code).toBe('json_too_deep')
    expect(deep.toHttpError().status).toBe(413)
    const keys = failure(`{${Array.from({ length: 1001 }, (_, i) => `"k${i}":1`).join(',')}}`)
    expect(keys.code).toBe('json_too_many_keys')
    expect(keys.toHttpError()).toBeInstanceOf(StrutvaneError)
    expect(keys.toHttpError().code).toBe('json_too_many_keys')
    // Brackets and colons inside strings don't count.
    expect(parseJsonSafely(`{"a":"${'[:'.repeat(5000)}"}`)).toBeDefined()
  })

  it('reports malformed JSON as invalid_json (400)', () => {
    for (const text of ['', '{', '{"a":1,}', "{'a':1}", 'undefined', '{"a":1}}']) {
      const error = failure(text)
      expect(error.code, text).toBe('invalid_json')
      expect(error.toHttpError().status).toBe(400)
    }
  })

  it('measures depth and keys in one pass, skipping strings and escapes', () => {
    expect(measureJson('{"a":[1,{"b":2}]}')).toEqual({ depth: 3, keys: 2 })
    expect(measureJson('{"a\\"{:":"}\\\\"}')).toEqual({ depth: 1, keys: 1 })
    expect(measureJson('1')).toEqual({ depth: 0, keys: 0 })
  })
})

describe('resolveLimits', () => {
  it('fills defaults and reports every bad limit without throwing', () => {
    expect(resolveLimits({ maxDepth: 64 })).toEqual({
      limits: { ...DEFAULT_BODY_LIMITS, maxDepth: 64 },
      problems: [],
    })
    const { problems } = resolveLimits({ maxBytes: 0, maxDepth: 1.5, maxKeys: 10_000_000 })
    expect(problems).toHaveLength(3)
    expect(problems[0]).toContain('limits.maxBytes')
  })
})
