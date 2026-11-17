import { describe, expect, test, vi } from 'vitest'
import { PROBLEM_CODES } from '../../src/contracts/index.ts'
import {
  BUILTIN_ERRORS,
  ConflictError,
  createErrorRegistry,
  createMessages,
  currentErrorCode,
  DomainError,
  defineMessages,
  ForbiddenError,
  fieldErrorsFrom,
  humanize,
  LEGACY_ERROR_CODES,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  StrutvaneError,
  toProblem,
  UnauthenticatedError,
  ValidationError,
} from '../../src/core/index.ts'

describe('error classes', () => {
  test('carry stable codes, statuses, params and headers', () => {
    expect(new NotFoundError('invoice')).toMatchObject({
      code: 'not_found',
      status: 404,
      params: { resource: 'invoice' },
    })
    expect(new NotFoundError().params).toEqual({})
    expect(new ForbiddenError()).toMatchObject({ code: 'forbidden', status: 403 })
    expect(new UnauthenticatedError()).toMatchObject({ code: 'unauthenticated', status: 401 })
    expect(new ConflictError()).toMatchObject({ code: 'conflict', status: 409 })
    expect(new ConflictError('stale_record', { currentVersion: 3 }).params).toEqual({
      currentVersion: 3,
    })
    expect(new DomainError('invoice_already_paid', { number: 'INV-1' })).toMatchObject({
      status: 422,
    })
    expect(new DomainError('X').params).toEqual({})
    expect(new RateLimitedError(2.5).headers).toEqual({ 'Retry-After': '3' })
    expect(new RateLimitedError().headers).toEqual({})
    expect(new ServiceUnavailableError(10)).toMatchObject({
      status: 503,
      headers: { 'Retry-After': '10' },
    })
    expect(() => new RateLimitedError(-1)).toThrow(RangeError)
  })

  test('name, message and cause are developer-friendly', () => {
    const cause = new Error('db down')
    const e = new DomainError('invoice_already_paid', { number: 'INV-1' }, { cause })
    expect(e.name).toBe('DomainError')
    expect(e.message).toBe('invoice_already_paid {"number":"INV-1"}')
    expect(e.cause).toBe(cause)
    expect(e).toBeInstanceOf(StrutvaneError)
    expect(Object.isFrozen(e.params)).toBe(true)
  })

  test('ValidationError needs issues and freezes them', () => {
    expect(() => new ValidationError([])).toThrow(TypeError)
    const v = new ValidationError([{ path: ['a'], code: 'required' }])
    expect(Object.isFrozen(v.issues[0]?.path)).toBe(true)
    expect(v.status).toBe(422)
  })
})

describe('error registry', () => {
  test('contains every contracts problem code', () => {
    const registry = createErrorRegistry()
    for (const code of PROBLEM_CODES) expect(registry.get(code)).toBeDefined()
    expect(BUILTIN_ERRORS).toHaveLength(PROBLEM_CODES.length)
  })

  test('registers new codes and rejects duplicates and invalid definitions', () => {
    const registry = createErrorRegistry()
    registry.register({
      code: 'invoice_already_paid',
      status: 409,
      title: 'Already paid',
      owner: 'app',
    })
    expect(registry.get('invoice_already_paid')?.title).toBe('Already paid')
    expect(() => registry.register({ code: 'not_found', status: 404, title: 'x' })).toThrow(
      /@strutvane\/framework/,
    )
    // snake_case (CONSISTENCY #68) or the older SCREAMING_SNAKE_CASE, never a mix of the two.
    registry.register({ code: 'csrf_token_mismatch', status: 419, title: 'Page expired' })
    for (const code of ['Mixed_Case', 'has space', '1leading', 'trailing-dash'])
      expect(() => registry.register({ code, status: 400, title: 'x' }), code).toThrow(/snake_case/)
    expect(() => registry.register({ code: 'OK_CODE', status: 200, title: 'x' })).toThrow(
      RangeError,
    )
    expect(registry.list().map((d) => d.code)).toContain('invoice_already_paid')
  })

  test('can start empty; duplicate messages say "another package" without an owner', () => {
    const registry = createErrorRegistry({ builtin: false })
    expect(registry.list()).toEqual([])
    registry.register({ code: 'A', status: 400, title: 'A' })
    expect(() => registry.register({ code: 'A', status: 400, title: 'A' })).toThrow(
      /another package/,
    )
  })
})

describe('toProblem', () => {
  test('issue paths named after Object.prototype members still render a 422 (attack-style)', () => {
    // Client-chosen unknown keys reach issue paths verbatim; none may resolve through the
    // prototype, crash rendering (a 500) or pollute Object.prototype.
    const names = [
      '__proto__',
      'constructor',
      'prototype',
      ...Object.getOwnPropertyNames(Object.prototype),
    ]
    const problem = toProblem(
      new ValidationError(names.map((n) => ({ path: [n], code: 'unknown_field' }))),
      { traceId: 't', labels: { amount: 'Amount' } },
    )
    expect(problem.status).toBe(422)
    expect(problem.issues).toHaveLength(names.length)
    const fieldErrors = problem.fieldErrors ?? {}
    for (const n of names) {
      expect(Object.hasOwn(fieldErrors, n)).toBe(true)
      expect(Array.isArray(fieldErrors[n])).toBe(true)
    }
    expect(Object.getPrototypeOf(fieldErrors)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    // A label map is never consulted through its prototype either.
    expect(problem.issues?.find((i) => i.path[0] === 'toString')?.message).not.toContain('function')
  })

  test('validation errors become 422 with rendered issues and fieldErrors', () => {
    const problem = toProblem(
      new ValidationError([
        { path: ['amount'], code: 'too_small', params: { min: 0 } },
        { path: ['lines', 1, 'unitPrice'], code: 'required' },
        { path: ['dueDate'], code: 'custom_rule' },
        { path: [], code: 'required' },
        { path: ['note'], code: 'x', message: 'Pre-rendered.' },
      ]),
      { traceId: 't1', instance: '/api/v1/invoices', labels: { amount: 'Amount (EUR)' } },
    )
    expect(problem).toMatchObject({
      type: 'https://strutvane.dev/errors/validation-failed',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      traceId: 't1',
      instance: '/api/v1/invoices',
    })
    expect(problem.issues?.map((i) => i.message)).toEqual([
      'Amount (EUR) must be at least 0.',
      'Unit price is required.',
      'Due date is invalid.',
      'This field is required.',
      'Pre-rendered.',
    ])
    // Every issue carries its dotted field next to the path (CONSISTENCY #69).
    expect(problem.issues?.map((i) => i.field)).toEqual([
      'amount',
      'lines.1.unitPrice',
      'dueDate',
      '',
      'note',
    ])
    expect(problem.issues?.[1]).toMatchObject({
      path: ['lines', 1, 'unitPrice'],
      field: 'lines.1.unitPrice',
    })
    expect(problem.issues?.[0]?.params).toEqual({ min: 0 })
    expect(problem.issues?.[1]).not.toHaveProperty('params')
    expect(problem.fieldErrors).toEqual({
      amount: ['Amount (EUR) must be at least 0.'],
      'lines.1.unitPrice': ['Unit price is required.'],
      dueDate: ['Due date is invalid.'],
      '': ['This field is required.'],
      note: ['Pre-rendered.'],
    })
  })

  test('unknown errors become 500 with NO internal details', () => {
    const secret = 'password=hunter2 at /srv/app/db.ts:42'
    const problem = toProblem(new Error(secret))
    expect(problem.status).toBe(500)
    expect(problem.code).toBe('internal_error')
    expect(JSON.stringify(problem)).not.toContain('hunter2')
    expect(JSON.stringify(problem)).not.toContain('/srv/app')
    expect(toProblem('a thrown string').code).toBe('internal_error')
    expect(toProblem(undefined).status).toBe(500)
  })

  test('uses registry status for codes without an explicit status, and humanizes unknown codes', () => {
    const registry = createErrorRegistry()
    registry.register({ code: 'INVOICE_LOCKED', status: 423, title: 'Invoice locked' })
    expect(toProblem(new StrutvaneError('INVOICE_LOCKED'), { registry })).toMatchObject({
      status: 423,
      title: 'Invoice locked',
    })
    expect(toProblem(new StrutvaneError('TOTALLY_UNKNOWN'))).toMatchObject({
      status: 500,
      title: 'Totally unknown',
    })
  })

  test('renders titles and details in the requested locale, with params', () => {
    const messages = createMessages({
      app: [
        defineMessages('hi', { 'errors.not_found.title': 'नहीं मिला' }),
        defineMessages('en', {
          'errors.invoice_already_paid.detail': 'Invoice {number} is already paid.',
        }),
      ],
    })
    expect(toProblem(new NotFoundError(), { messages, locale: 'hi' }).title).toBe('नहीं मिला')
    expect(
      toProblem(new DomainError('invoice_already_paid', { number: 'INV-7' }), { messages }).detail,
    ).toBe('Invoice INV-7 is already paid.')
  })

  test('honours a custom type base and field overrides', () => {
    const problem = toProblem(new ValidationError([{ path: ['sku'], code: 'required' }]), {
      typeBase: 'https://acme.test/errors/',
      overrides: { field: { '*': { 'validation.required': 'Please enter a SKU.' } } },
    })
    expect(problem.type).toBe('https://acme.test/errors/validation-failed')
    expect(problem.issues?.[0]?.message).toBe('Please enter a SKU.')
  })

  test('never throws: a broken catalog yields a minimal 500', () => {
    const broken = {
      has: () => {
        throw new Error('broken catalog')
      },
    } as unknown as ReturnType<typeof createMessages>
    expect(toProblem(new NotFoundError(), { messages: broken, traceId: 't' })).toEqual({
      type: 'https://strutvane.dev/errors/internal-error',
      title: 'Something went wrong',
      status: 500,
      code: 'internal_error',
      traceId: 't',
    })
  })
})

describe('uppercase codes: the 0.2 compatibility window (CONSISTENCY #123)', () => {
  const deprecations = (spy: { mock: { calls: unknown[][] } }): string[] =>
    spy.mock.calls
      .filter(
        (call) =>
          (call[1] as { code?: string } | undefined)?.code === 'STRUTVANE_UPPERCASE_ERROR_CODE',
      )
      .map((call) => String(call[0]))

  test('every built-in and framework code is lowercase snake_case, and every old name maps to it', () => {
    for (const definition of BUILTIN_ERRORS) expect(definition.code).toMatch(/^[a-z][a-z0-9_]*$/)
    for (const [old, renamed] of Object.entries(LEGACY_ERROR_CODES)) {
      expect(old).toMatch(/^[A-Z][A-Z0-9_]*$/)
      expect(renamed).toBe(old.toLowerCase())
    }
    for (const code of PROBLEM_CODES) expect(LEGACY_ERROR_CODES[code.toUpperCase()]).toBe(code)
  })

  test('an error thrown with an old name carries the new one, with one deprecation warning', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      expect(new StrutvaneError('STALE_RECORD').code).toBe('stale_record')
      expect(new ConflictError('STALE_RECORD').code).toBe('stale_record')
      expect(toProblem(new DomainError('QUOTA_EXCEEDED')).code).toBe('quota_exceeded')
      expect(deprecations(spy)).toEqual([
        'Error code "STALE_RECORD" was renamed to "stale_record" in @strutvane/framework 0.2; the old name stops working in 0.3. Use "stale_record".',
        'Error code "QUOTA_EXCEEDED" was renamed to "quota_exceeded" in @strutvane/framework 0.2; the old name stops working in 0.3. Use "quota_exceeded".',
      ])
      // Current names, app codes and anything unknown pass through without a warning.
      spy.mockClear()
      expect(currentErrorCode('not_found')).toBe('not_found')
      expect(currentErrorCode('invoice_already_paid')).toBe('invoice_already_paid')
      expect(currentErrorCode('toString')).toBe('toString')
      expect(deprecations(spy)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test('the registry finds an old name, and registering one collides with the built-in', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const registry = createErrorRegistry()
      expect(registry.get('PAYLOAD_TOO_LARGE')).toBe(registry.get('payload_too_large'))
      expect(registry.get('PAYLOAD_TOO_LARGE')?.status).toBe(413)
      expect(() => registry.register({ code: 'FILE_EMPTY', status: 422, title: 'x' })).toThrow(
        'Error code "file_empty" is already registered by @strutvane/framework',
      )
      const empty = createErrorRegistry({ builtin: false })
      empty.register({
        code: 'TOO_MANY_FILES',
        status: 413,
        title: 'Too many',
        owner: 'old-plugin',
      })
      expect(empty.get('too_many_files')?.owner).toBe('old-plugin')
      expect(deprecations(spy)).toHaveLength(3)
    } finally {
      spy.mockRestore()
    }
  })

  test("an app's own uppercase code is still accepted until 0.3, with a warning; mixed case never is", () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const registry = createErrorRegistry()
      registry.register({ code: 'LEDGER_CLOSED', status: 409, title: 'Ledger closed' })
      registry.register({ code: 'LEDGER_LOCKED', status: 409, title: 'Ledger locked' })
      expect(registry.get('LEDGER_CLOSED')?.status).toBe(409)
      expect(deprecations(spy)).toEqual([
        'Error code "LEDGER_CLOSED" is uppercase; Strutvane codes are lowercase snake_case from 0.2 ("ledger_closed"). Uppercase codes stop being accepted in 0.3.',
        'Error code "LEDGER_LOCKED" is uppercase; Strutvane codes are lowercase snake_case from 0.2 ("ledger_locked"). Uppercase codes stop being accepted in 0.3.',
      ])
      expect(() => registry.register({ code: 'Ledger_Open', status: 409, title: 'x' })).toThrow(
        'must be lowercase snake_case, such as "invoice_already_paid"',
      )
    } finally {
      spy.mockRestore()
    }
  })
})

describe('helpers', () => {
  test('humanize', () => {
    expect(humanize('dueDate')).toBe('Due date')
    expect(humanize('customer_id')).toBe('Customer id')
    expect(humanize('')).toBe('')
  })
  test('fieldErrorsFrom groups by dotted path', () => {
    expect(
      fieldErrorsFrom([
        { path: ['a', 0], field: 'a.0', code: 'x', message: 'one' },
        { path: ['a', 0], field: 'a.0', code: 'y', message: 'two' },
      ]),
    ).toEqual({ 'a.0': ['one', 'two'] })
  })
})
