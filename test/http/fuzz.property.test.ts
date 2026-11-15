/**
 * Property-based fuzzing of every parser a client can reach, and of the error renderer
 * (docs/13 §14: "fuzz every parser"). The invariant everywhere: hostile input is answered, never
 * crashes, never becomes a 500, and never echoes an internal error message back to the client.
 *
 * - the list-query parser (`filter[..][..]`, `sort`, `page[..]`, `search`, `include`);
 * - the whole HTTP app: random methods, paths (route params, encodings, traversal), query strings,
 *   content types and bodies;
 * - the problem+json builder, fed arbitrary thrown values;
 * - the `.env` parser.
 *
 * Cookies are not parsed by the framework (auth owns sessions), so there is no cookie parser here.
 */
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseEnv } from '../../src/console/project/env-file.ts'
import {
  createErrorRegistry,
  createMessages,
  StrutvaneError,
  toProblem,
} from '../../src/core/index.ts'
import { parseListQuery } from '../../src/http/list-query.ts'
import { route } from '../../src/http/route.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { queryFields } from '../../src/query/fields.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'

const Note = defineModel(
  'Note',
  {
    title: field.string(80).searchable().sortable().filterable(),
    amount: field.decimal(10, 2).sortable().filterable(),
    status: field.enum(['open', 'done']).default('open').filterable(),
    dueOn: field.date().optional().filterable().sortable(),
  },
  { timestamps: true, softDeletes: true },
)

/** Strings that look like what attackers and broken clients actually send. */
const nasty = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom(
    '',
    '[',
    ']',
    '[]',
    '%',
    '%zz',
    '%00',
    '..',
    '../..',
    '__proto__',
    'constructor',
    'prototype',
    '-',
    ',',
    ',,,',
    'null',
    'NaN',
    '1e309',
    '-0',
    '9'.repeat(400),
    "'; DROP TABLE notes; --",
    '\u0000',
    '\uD800',
    '‮',
    'a'.repeat(5000),
  ),
)
const fieldName = fc.oneof(
  fc.constantFrom('title', 'amount', 'status', 'dueOn', 'id', 'createdAt', 'deletedAt', 'trashed'),
  nasty,
)
const operator = fc.oneof(
  fc.constantFrom('eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between', 'contains'),
  fc.constantFrom('startsWith', 'endsWith', 'isNull', 'isNotNull', 'like', 'raw'),
  nasty,
)
const queryKey = fc.oneof(
  fc.tuple(fieldName, operator).map(([f, o]) => `filter[${f}][${o}]`),
  fieldName.map((f) => `filter[${f}]`),
  fc.constantFrom(
    'sort',
    'page[size]',
    'page[number]',
    'page[cursor]',
    'page[total]',
    'search',
    'include',
    'fields[notes]',
  ),
  nasty,
)
const queryEntries = fc.array(fc.tuple(queryKey, nasty), { maxLength: 12 })
const toSearch = (entries: readonly (readonly [string, string])[]): URLSearchParams => {
  const search = new URLSearchParams()
  for (const [k, v] of entries) search.append(k, v)
  return search
}

describe('fuzz: list-query parser', () => {
  const rules = { fields: queryFields(Note.definition), includes: [] }
  it('never throws; either a query or a list of issues, each with a code', () => {
    fc.assert(
      fc.property(queryEntries, (entries) => {
        const result = parseListQuery(toSearch(entries), rules)
        if (result.ok) expect(result.query).toBeDefined()
        else {
          expect(result.issues.length).toBeGreaterThan(0)
          for (const issue of result.issues) expect(typeof issue.code).toBe('string')
        }
      }),
      { numRuns: 2000 },
    )
  })
})

describe('fuzz: the whole HTTP app', () => {
  let app: TestApp
  beforeAll(async () => {
    app = await createTestApp({
      resources: [Note],
      http: {
        routes: [
          route.get('/items/:id/parts/:part', {
            public: true,
            handler: (c) => ({ id: c.params['id'], part: c.params['part'] }),
          }),
          route.post('/echo', { public: true, handler: async (c) => c.json() }),
        ],
      },
    })
    await app.resource(Note).create({ title: 'seed', amount: '1.00' } as never)
  })
  afterAll(async () => {
    await app.close()
  })

  const segment = fc.oneof(
    fc.constantFrom('api', 'v1', 'notes', 'items', 'parts', 'echo', 'query', 'restore', 'health'),
    nasty.map((s) => encodeURIComponent(s.toWellFormed())),
    nasty.map((s) => s.replace(/[?#\s]/g, '')),
  )
  const path = fc.oneof(
    fc.array(segment, { maxLength: 6 }).map((s) => `/api/v1/${s.join('/')}`),
    fc.array(segment, { maxLength: 6 }).map((s) => `/${s.join('/')}`),
  )
  const contentType = fc.oneof(
    fc.constantFrom(
      'application/json',
      'application/json; charset=utf-8',
      'application/vnd.api+json',
      'APPLICATION/JSON',
      'application/jsonx',
      'text/plain',
      'multipart/form-data',
      'multipart/form-data; boundary=',
      'application/x-www-form-urlencoded',
      '',
    ),
    nasty,
  )
  const body = fc.oneof(
    fc.json(),
    nasty,
    fc.constantFrom('{', '{"title":', '{"__proto__":{"admin":true}}', '[1,2', 'null', '"x"'),
    fc.object().map((o) => JSON.stringify(o)),
  )

  it('every request is answered, never with a 500, and errors are problem+json', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'),
        path,
        queryEntries,
        contentType,
        body,
        async (method, p, query, type, payload) => {
          const qs = toSearch(query).toString()
          const url = `http://app.test${p}${qs ? `?${qs}` : ''}`
          let request: Request
          try {
            request = new Request(url, {
              method,
              headers: type && /^[\t\x20-\x7e]*$/.test(type) ? { 'content-type': type } : {},
              ...(method === 'GET' || method === 'HEAD' ? {} : { body: payload }),
            })
          } catch {
            return // not a request a client could send (an invalid URL or header)
          }
          const res = await app.http.fetch(request)
          const text = await res.text()
          expect(res.status, `${method} ${url} (${type}) → ${text.slice(0, 300)}`).not.toBe(500)
          if (res.status >= 400 && method !== 'HEAD')
            expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/)
        },
      ),
      { numRuns: 400 },
    )
  }, 300_000)
})

describe('fuzz: problem+json builder', () => {
  const messages = createMessages()
  const registry = createErrorRegistry()
  const SECRET = 'postgres://app:hunter2@db.internal/app'
  it('renders any thrown value; unknown errors never leak their message', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.string().map((m) => new Error(`${m} ${SECRET}`)),
          fc.string().map((m) => Object.assign(new TypeError(m), { detail: SECRET })),
          fc
            .tuple(fc.string(), fc.anything())
            .map(([code, params]) => new StrutvaneError(code, { params: params as never })),
        ),
        (thrown) => {
          const problem = toProblem(thrown, { messages, registry, traceId: 't' })
          expect(problem.status).toBeGreaterThanOrEqual(400)
          expect(problem.status).toBeLessThan(600)
          expect(typeof problem.code).toBe('string')
          expect(() => JSON.stringify(problem)).not.toThrow()
          if (!(thrown instanceof StrutvaneError))
            expect(JSON.stringify(problem)).not.toContain('hunter2')
        },
      ),
      { numRuns: 2000 },
    )
  })
})

describe('fuzz: .env parser', () => {
  it('never throws, and every entry it reports comes from a line of the input', () => {
    const line = fc.oneof(
      fc.tuple(nasty, nasty).map(([k, v]) => `${k}=${v}`),
      fc.tuple(fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,10}$/), nasty).map(([k, v]) => `${k}=${v}`),
      fc
        .tuple(fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,10}$/), nasty)
        .map(([k, v]) => `export ${k}="${v}"`),
      nasty,
    )
    fc.assert(
      fc.property(
        fc.array(line, { maxLength: 30 }),
        fc.constantFrom('\n', '\r\n'),
        (lines, eol) => {
          const text = lines.join(eol)
          const parsed = parseEnv(text)
          const count = text.replace(/^﻿/, '').split(/\r?\n/).length
          for (const entry of parsed.all) {
            expect(entry.line).toBeGreaterThanOrEqual(1)
            expect(entry.line).toBeLessThanOrEqual(count)
          }
          for (const bad of parsed.invalid) expect(bad.line).toBeLessThanOrEqual(count)
        },
      ),
      { numRuns: 2000 },
    )
  })
})
