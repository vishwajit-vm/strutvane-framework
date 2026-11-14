import { describe, expect, it } from 'vitest'
import { columnName, defineModel } from '../../src/model/define-model.ts'
import { field, isNumericKind, isTextKind, operatorsFor } from '../../src/model/field.ts'
import { humanLabel, kebabCase, lowerCamel, pluralize, snakeCase } from '../../src/model/naming.ts'
import { createModelRegistry, dependencyOrder, validateModels } from '../../src/model/registry.ts'
import { issuesFromZod, modelLabels, modelSchemas, valueSchema } from '../../src/model/schemas.ts'

describe('naming', () => {
  it('derives names consistently', () => {
    expect(snakeCase('InvoiceLine')).toBe('invoice_line')
    expect(snakeCase('HTTPRequest')).toBe('http_request')
    expect(snakeCase('due date')).toBe('due_date')
    expect(lowerCamel('InvoiceLine')).toBe('invoiceLine')
    expect(kebabCase('invoiceLines')).toBe('invoice-lines')
    expect(pluralize('category')).toBe('categories')
    expect(pluralize('box')).toBe('boxes')
    expect(pluralize('day')).toBe('days')
    expect(pluralize('invoice')).toBe('invoices')
    expect(humanLabel('dueDate')).toBe('Due date')
    expect(humanLabel('customer_id')).toBe('Customer id')
  })
})

describe('field builders', () => {
  it('produce plain, immutable definitions', () => {
    const base = field.string()
    const unique = base.unique()
    expect(base.def.unique).toBe(false)
    expect(unique.def.unique).toBe(true)
    expect(Object.isFrozen(unique.def)).toBe(true)
    expect(JSON.parse(JSON.stringify(unique.def))).toEqual(unique.def)
  })

  it('apply every modifier', () => {
    const f = field
      .string(40)
      .optional()
      .nullable()
      .required()
      .index()
      .min(2)
      .max(30)
      .regex(/^[a-z]+$/g)
      .searchable()
      .filterable('eq', 'contains')
      .sortable()
      .hidden()
      .writeOnce()
      .sensitive()
      .label('Code')
      .help('Lowercase letters')
      .default('abc')
      .readOnly()
    expect(f.def).toMatchObject({
      kind: 'string',
      length: 40,
      required: true,
      index: true,
      min: 2,
      max: 30,
      pattern: { source: '^[a-z]+$', flags: '' },
      searchable: true,
      filterOperators: ['eq', 'contains'],
      sortable: true,
      hidden: true,
      writeOnce: true,
      sensitive: true,
      label: 'Code',
      help: 'Lowercase letters',
      default: 'abc',
      readOnly: true,
    })
    expect(field.integer().filterable().def.filterOperators).toEqual(operatorsFor('integer'))
  })

  it('reject invalid modifiers early, with clear messages', () => {
    expect(() => field.enum(['a', 'b']).default('c' as 'a')).toThrow(/not one of the enum values/)
    expect(() => field.json().default('x' as never)).toThrow(/cannot have a schema default/)
    expect(() => field.integer().regex(/x/)).toThrow(/only for text/)
    expect(() => field.integer().searchable()).toThrow(/only for text/)
    expect(() => field.json().filterable('eq')).toThrow(/don't support filter operator/)
    expect(() => field.text().sortable()).toThrow(/cannot be sortable/)
    expect(() => field.boolean().min(1)).toThrow(/not supported on boolean/)
    expect(() => field.integer().min(Number.NaN)).toThrow(/finite/)
    expect(() => field.string().min(-1)).toThrow(/length/)
    expect(() => field.integer().min(5).max(1)).toThrow(/cannot be greater/)
    expect(() => field.string(10).max(20)).toThrow(/exceeds the column length/)
    expect(() => field.string().label('  ')).toThrow(/non-empty/)
    expect(() => field.string(0)).toThrow(/positive integer/)
    expect(() => field.decimal(5, 6)).toThrow(/scale/)
    expect(() => field.enum(['a', 'a'])).toThrow(/unique/)
    expect(() => field.enum([''])).toThrow(/1-64/)
    expect(() => field.belongsTo('customer')).toThrow(/PascalCase/)
    expect(() => field.hasMany('lines')).toThrow(/PascalCase/)
  })

  it('classifies kinds', () => {
    expect(isNumericKind('decimal')).toBe(true)
    expect(isTextKind('email')).toBe(true)
    expect(isTextKind('uuid')).toBe(false)
  })
})

describe('defineModel', () => {
  it('derives table, path, permission, labels and title', () => {
    const m = defineModel('InvoiceLine', { description: field.string(), qty: field.integer() })
    expect(m.definition).toMatchObject({
      name: 'InvoiceLine',
      table: 'invoice_lines',
      path: 'invoice-lines',
      permission: 'invoiceLine',
      label: 'Invoice line',
      pluralLabel: 'Invoice lines',
      title: 'description',
      options: { timestamps: true, softDeletes: false, tenant: false, audit: false },
    })
    expect(m.definition.fields['qty']?.label).toBe('Qty')
    expect(Object.isFrozen(m.definition)).toBe(true)
    const custom = defineModel(
      'Person',
      { n: field.integer() },
      { table: 'people', label: 'Human', pluralLabel: 'Humans' },
    )
    expect(custom.definition).toMatchObject({
      table: 'people',
      title: 'id',
      label: 'Human',
      pluralLabel: 'Humans',
    })
    expect(columnName('customer', field.belongsTo('Customer').def)).toBe('customer_id')
  })

  it('rejects invalid definitions', () => {
    expect(() => defineModel('invoice', { a: field.string() })).toThrow(/PascalCase/)
    expect(() => defineModel('Invoice', { Bad: field.string() })).toThrow(/lowerCamelCase/)
    expect(() => defineModel('Invoice', { createdAt: field.datetime() })).toThrow(/reserved column/)
    expect(() => defineModel('Invoice', { tenantId: field.uuid() })).toThrow(/reserved column/)
    expect(() =>
      defineModel('Invoice', { customer: field.belongsTo('Customer'), customerId: field.uuid() }),
    ).toThrow(/two fields map to the column/)
    expect(() => defineModel('Invoice', { lines: field.hasMany('Line') })).toThrow(
      /at least one field/,
    )
    expect(() => defineModel('Invoice', { a: field.string() }, { title: 'nope' })).toThrow(
      /title field/,
    )
    expect(() => defineModel('Invoice', { a: field.string() }, { table: 'Bad-Name' })).toThrow(
      /valid identifier/,
    )
  })
})

describe('model registry', () => {
  const Customer = defineModel('Customer', {
    name: field.string(),
    invoices: field.hasMany('Invoice'),
  })
  const Invoice = defineModel('Invoice', {
    customer: field.belongsTo('Customer'),
    parent: field.belongsTo('Invoice').optional(),
  })

  it('orders by dependency and looks models up', () => {
    const r = createModelRegistry([Invoice, Customer.definition])
    expect(r.all.map((m) => m.name)).toEqual(['Customer', 'Invoice'])
    expect(r.get('Invoice')?.table).toBe('invoices')
    expect(r.byPath('customers')?.name).toBe('Customer')
    expect(() => r.require('Nope')).toThrow(/Unknown model/)
  })

  it('reports every problem in a model set at once', () => {
    const Orphan = defineModel('Orphan', {
      owner: field.belongsTo('Ghost'),
      kids: field.hasMany('Ghost'),
    })
    const BadBack = defineModel('Parent', { name: field.string(), kids: field.hasMany('Customer') })
    const Dup = defineModel('Customer', { x: field.string() }, { table: 'customers' })
    let message = ''
    try {
      validateModels([
        Customer.definition,
        Invoice.definition,
        Orphan.definition,
        BadBack.definition,
        Dup.definition,
      ])
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('duplicate model name "Customer"')
    expect(message).toContain('duplicate table "customers"')
    expect(message).toContain('Orphan.owner belongsTo unknown model "Ghost"')
    expect(message).toContain('Orphan.kids hasMany unknown model "Ghost"')
    expect(message).toContain("Customer.parent must be belongsTo('Parent')")
  })

  it('rejects belongsTo cycles', () => {
    const A = defineModel('Aa', { b: field.belongsTo('Bb') })
    const B = defineModel('Bb', { a: field.belongsTo('Aa') })
    expect(() => dependencyOrder([A.definition, B.definition])).toThrow(/Cyclic/)
  })
})

describe('schemas', () => {
  const Thing = defineModel(
    'Thing',
    {
      name: field.string(10).min(2),
      code: field.string().writeOnce(),
      secret: field.string().hidden().optional(),
      computed: field.integer().readOnly().optional(),
      price: field.decimal(6, 2).min(0).max(1000),
      big: field.bigInteger().optional(),
      kind: field.enum(['a', 'b']).default('a'),
      site: field.url().optional(),
      mail: field.email().optional(),
      day: field.date().optional(),
      at: field.datetime().optional(),
      flag: field.boolean().optional(),
      ratio: field.float().min(0).max(1).optional(),
      data: field.json().optional(),
      ref: field.uuid().optional(),
      slug: field
        .string()
        .regex(/^[a-z-]+$/)
        .optional(),
    },
    { softDeletes: true },
  )
  const s = modelSchemas(Thing.definition)

  it('makes create strict, excludes readOnly, and requires only required fields without defaults', () => {
    const ok = s.create.safeParse({ name: 'ab', code: 'X', price: '10.50' })
    expect(ok.success).toBe(true)
    const r = s.create.safeParse({
      computed: 1,
      name: 'a',
      price: '10.555',
      extra: true,
      big: '1.5',
      site: 'ftp://x',
      kind: 'z',
    })
    expect(r.success).toBe(false)
    const codes = issuesFromZod(r.error?.issues ?? [])
      .map((i) => `${i.path.join('.')}:${i.code}`)
      .sort()
    expect(codes).toEqual(
      [
        'big:invalid_format',
        'code:required',
        'computed:unknown_field',
        'extra:unknown_field',
        'kind:not_in_list',
        'name:too_short',
        'price:invalid_decimal',
        'site:invalid_url',
      ].sort(),
    )
  })

  it('makes update partial, excluding readOnly and writeOnce fields', () => {
    expect(s.update.safeParse({}).success).toBe(true)
    const input = { code: 'Y', name: null }
    const r = s.update.safeParse(input)
    expect(
      issuesFromZod(r.error?.issues ?? [], [], input)
        .map((i) => `${i.path.join('.')}:${i.code}`)
        .sort(),
    ).toEqual(['code:unknown_field', 'name:invalid_type'])
  })

  it('hides hidden fields from read and includes system fields', () => {
    const shape = Object.keys(s.read.shape)
    expect(shape).not.toContain('secret')
    expect(shape).toEqual(
      expect.arrayContaining(['id', 'createdAt', 'updatedAt', 'deletedAt', 'computed']),
    )
  })

  it('maps bounds and formats to catalog codes', () => {
    const issues = (patch: Record<string, unknown>) => {
      const input = { name: 'ab', code: 'X', price: '1', ...patch }
      return issuesFromZod(s.create.safeParse(input).error?.issues ?? [], ['body'], input)
    }
    expect(issues({ price: '1000.01' })).toEqual([
      { path: ['body', 'price'], code: 'too_big', params: { max: 1000 } },
    ])
    expect(issues({ price: '-1' })).toEqual([
      { path: ['body', 'price'], code: 'too_small', params: { min: 0 } },
    ])
    expect(issues({ name: 'x'.repeat(11) })).toEqual([
      { path: ['body', 'name'], code: 'too_long', params: { max: 10 } },
    ])
    expect(issues({ ratio: 2 })[0]?.code).toBe('too_big')
    expect(issues({ mail: 'nope' })[0]?.code).toBe('invalid_email')
    expect(issues({ ref: 'nope' })[0]?.code).toBe('invalid_uuid')
    expect(issues({ day: '2026-13-01' })[0]?.code).toBe('invalid_date')
    expect(issues({ at: '2026-01-01T00:00:00' })[0]?.code).toBe('invalid_date')
    expect(issues({ slug: 'NO' })[0]?.code).toBe('invalid_format')
    expect(issues({ flag: 'yes' })[0]?.code).toBe('invalid_type')
    expect(issues({ data: { a: [1, { b: null }] } })).toEqual([])
    expect(issues({ data: () => 1 })[0]?.code).toBeDefined()
  })

  it('refuses NUL characters in every text kind and blank values in required text (422, not a 500)', () => {
    const issues = (patch: Record<string, unknown>, schema = s.create) => {
      const input = { name: 'ab', code: 'X', price: '1', ...patch }
      return issuesFromZod(schema.safeParse(input).error?.issues ?? [], [], input)
    }
    // PostgreSQL text cannot hold U+0000: the insert used to fail inside the database.
    expect(issues({ name: 'a\u0000b' })).toEqual([{ path: ['name'], code: 'invalid_format' }])
    expect(issues({ mail: 'a\u0000@b.test' })[0]?.code).toBeDefined()
    expect(issues({ slug: 'a\u0000' })[0]?.code).toBe('invalid_format')
    // A required text field needs content; optional text may be empty.
    const Note = defineModel('Note', {
      title: field.string(),
      body: field.text(),
      extra: field.string().optional(),
    })
    const n = modelSchemas(Note.definition)
    const noteIssues = (input: Record<string, unknown>, schema = n.create) =>
      issuesFromZod(schema.safeParse(input).error?.issues ?? [], [], input)
    expect(noteIssues({ title: '', body: 'x' })).toEqual([{ path: ['title'], code: 'required' }])
    expect(noteIssues({ title: '  \t', body: 'x' })).toEqual([
      { path: ['title'], code: 'required' },
    ])
    expect(noteIssues({ title: 'ok', body: ' ' })).toEqual([{ path: ['body'], code: 'required' }])
    expect(noteIssues({ title: 'ok', body: 'x', extra: '' })).toEqual([])
    expect(noteIssues({ title: '' }, n.update)).toEqual([{ path: ['title'], code: 'required' }])
  })

  it('validates integers within 32 bits and labels fields', () => {
    const n = valueSchema(field.integer().def)
    expect(n.safeParse(2 ** 31).success).toBe(false)
    expect(n.safeParse(1.5).success).toBe(false)
    expect(modelLabels(Thing.definition)).toMatchObject({
      id: 'ID',
      name: 'Name',
      createdAt: 'Created at',
    })
  })
})
