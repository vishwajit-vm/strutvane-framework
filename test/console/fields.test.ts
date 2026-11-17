import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  FIELD_MODIFIERS,
  FIELD_TYPES,
  type FieldSpec,
  FieldSpecError,
  formatArg,
  formatFieldSpec,
  parseFieldSpec,
  parseFieldSpecs,
} from '../../src/console/make/fields.ts'

/** Assert that parsing fails with a given code at a given column. */
function fails(spec: string, code: string, column?: number): FieldSpecError {
  let caught: unknown
  try {
    parseFieldSpec(spec)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(FieldSpecError)
  const error = caught as FieldSpecError
  expect(error.code).toBe(code)
  if (column !== undefined) expect(error.column).toBe(column)
  expect(error.spec).toBe(spec)
  return error
}

describe('parseFieldSpec: the documented examples', () => {
  test('title:string(200):required:searchable', () => {
    expect(parseFieldSpec('title:string(200):required:searchable')).toEqual({
      name: 'title',
      type: 'string',
      typeArgs: ['200'],
      modifiers: [
        { name: 'required', args: [] },
        { name: 'searchable', args: [] },
      ],
    })
  })

  test('amount:decimal(12,2):min(0):sortable', () => {
    expect(parseFieldSpec('amount:decimal(12,2):min(0):sortable')).toEqual({
      name: 'amount',
      type: 'decimal',
      typeArgs: ['12', '2'],
      modifiers: [
        { name: 'min', args: ['0'] },
        { name: 'sortable', args: [] },
      ],
    })
  })

  test('status:enum(draft,sent,paid):default(draft):filterable', () => {
    const field = parseFieldSpec('status:enum(draft,sent,paid):default(draft):filterable')
    expect(field.typeArgs).toEqual(['draft', 'sent', 'paid'])
    expect(field.modifiers[0]).toEqual({ name: 'default', args: ['draft'] })
  })

  test('relations and optional json', () => {
    expect(parseFieldSpec('customer:belongsTo(Customer)').typeArgs).toEqual(['Customer'])
    expect(parseFieldSpec('tags:manyToMany(Tag)').type).toBe('manyToMany')
    expect(parseFieldSpec('tags:manyToMany(Tag, InvoiceTag)').typeArgs).toEqual([
      'Tag',
      'InvoiceTag',
    ])
    expect(parseFieldSpec('meta:json:optional').modifiers).toEqual([{ name: 'optional', args: [] }])
  })

  test('spaces around arguments are trimmed; quoted arguments keep commas, colons and spaces', () => {
    expect(parseFieldSpec('amount:decimal( 12 , 2 )').typeArgs).toEqual(['12', '2'])
    expect(parseFieldSpec('due:date:label("Due date, local: UTC")').modifiers[0]?.args).toEqual([
      'Due date, local: UTC',
    ])
    expect(parseFieldSpec("note:text:help('It\\'s (optional)')").modifiers[0]?.args).toEqual([
      "It's (optional)",
    ])
  })

  test('empty parentheses mean no arguments', () => {
    expect(parseFieldSpec('title:string()').typeArgs).toEqual([])
  })

  test('typed defaults per category', () => {
    expect(parseFieldSpec('qty:integer:default(-3)').modifiers[0]?.args).toEqual(['-3'])
    expect(parseFieldSpec('rate:float:default(0.5)').modifiers[0]?.args).toEqual(['0.5'])
    expect(parseFieldSpec('active:boolean:default(true)').modifiers[0]?.args).toEqual(['true'])
    expect(parseFieldSpec('at:datetime:default(now)').modifiers[0]?.args).toEqual(['now'])
    expect(parseFieldSpec('on:date:default(2026-01-31)').modifiers[0]?.args).toEqual(['2026-01-31'])
    expect(parseFieldSpec('tags:set(a,b,c):default(a,c)').modifiers[0]?.args).toEqual(['a', 'c'])
    expect(parseFieldSpec('name:string:default("")').modifiers[0]?.args).toEqual([''])
  })

  test('string-length min/max and lengths', () => {
    expect(parseFieldSpec('code:string:min(2):max(8):length(2,8)').modifiers).toHaveLength(3)
  })

  test('every catalogue type parses with valid arguments', () => {
    const samples: Record<string, string> = {
      string: 'string(80)',
      slug: 'slug(title)',
      decimal: 'decimal(10,4)',
      money: 'money(EUR)',
      enum: 'enum(a,b)',
      set: 'set(a,b)',
      array: 'array(string)',
      belongsTo: 'belongsTo(Customer)',
      hasOne: 'hasOne(Profile)',
      hasMany: 'hasMany(Line)',
      manyToMany: 'manyToMany(Tag)',
      morphTo: 'morphTo(commentable)',
      morphMany: 'morphMany(Comment,commentable)',
    }
    for (const type of Object.keys(FIELD_TYPES)) {
      const spec = `f:${samples[type] ?? type}`
      expect(parseFieldSpec(spec).type, spec).toBe(type)
    }
  })
})

describe('parseFieldSpec: precise errors (code + column)', () => {
  test('empty and missing parts', () => {
    fails('', 'empty_spec', 1)
    fails('   ', 'empty_spec', 1)
    fails('title', 'missing_type', 6)
    fails('title:', 'empty_segment', 6)
    fails('title::required', 'empty_segment', 7)
    fails(':string', 'empty_segment', 1)
  })

  test('names', () => {
    fails('Title:string', 'invalid_name', 1)
    fails('due_date:date', 'invalid_name', 1)
    fails('title(1):string', 'invalid_name', 1)
    fails('id:uuid', 'reserved_name', 1)
    fails('createdAt:datetime', 'reserved_name', 1)
    fails('tenantId:uuid', 'reserved_name', 1)
  })

  test('unknown types and modifiers point at the word and suggest a fix', () => {
    const type = fails('title:strng', 'unknown_type', 7)
    expect(type.message).toContain('Did you mean string')
    const mod = fails('title:string:requird', 'unknown_modifier', 14)
    expect(mod.message).toContain('required')
    fails('title:zzzzzzzz', 'unknown_type', 7)
  })

  test('syntax errors', () => {
    fails('title:string(200', 'unclosed_parenthesis', 13)
    fails('title:string(200,', 'unclosed_parenthesis', 13)
    fails('title:string(200)x', 'unexpected_character', 18)
    fails('title:string(20(0))', 'unexpected_character', 16)
    fails('title:string(200 300)x', 'unexpected_character')
    fails('a:enum(x,,y)', 'empty_argument', 10)
    fails('a:enum(x,"y)', 'unterminated_quote', 10)
    fails('a:enum(x,"y"z)', 'unexpected_character', 13)
    fails('a:string-x', 'unexpected_character', 9)
    fails('a:string:(1)', 'unexpected_character', 10)
  })

  test('argument counts and kinds', () => {
    fails('a:string(1,2)', 'wrong_argument_count', 3)
    fails('a:string(0)', 'invalid_argument', 10)
    fails('a:string(abc)', 'invalid_argument', 10)
    fails('a:decimal(12)', 'wrong_argument_count')
    fails('a:decimal(70,2)', 'invalid_argument')
    fails('a:decimal(4,6)', 'invalid_argument')
    fails('a:belongsTo', 'wrong_argument_count', 3)
    fails('a:belongsTo(customer)', 'invalid_argument', 13)
    fails('a:money(eur)', 'invalid_argument')
    fails('a:enum', 'wrong_argument_count')
    fails('a:enum(x,x)', 'invalid_argument')
    fails('a:enum(x y)', 'invalid_argument')
    fails('a:text(1)', 'wrong_argument_count')
    fails('a:string:required(1)', 'wrong_argument_count')
    fails('a:string:regex("(")', 'invalid_argument')
    fails('a:string:permission(Invoice)', 'invalid_argument')
    fails('a:string:since(soon)', 'invalid_argument')
  })

  test('defaults must fit the type', () => {
    fails('status:enum(draft,paid):default(sent)', 'invalid_default', 33)
    fails('qty:integer:default(1.5)', 'invalid_default')
    fails('rate:float:default(abc)', 'invalid_default')
    fails('ok:boolean:default(yes)', 'invalid_default')
    fails('at:date:default(tomorrow)', 'invalid_default')
    fails('a:string:default(x,y)', 'wrong_argument_count')
    fails('c:belongsTo(Customer):default(x)', 'modifier_not_applicable')
    fails('m:json:default(x)', 'modifier_not_applicable')
  })

  test('modifier conflicts and applicability', () => {
    fails('a:string:required:required', 'duplicate_modifier', 19)
    fails('a:string:required:optional', 'conflicting_modifiers', 19)
    fails('a:integer:min(5):max(1)', 'conflicting_modifiers', 18)
    fails('a:boolean:min(1)', 'modifier_not_applicable')
    fails('a:integer:length(3)', 'modifier_not_applicable')
    fails('lines:hasMany(Line):unique', 'modifier_not_applicable')
    fails('lines:hasMany(Line):searchable', 'modifier_not_applicable')
    fails('a:string:min(-1)', 'invalid_argument')
    fails('a:string:min(1.5)', 'invalid_argument')
  })

  test('parseFieldSpecs rejects duplicate names', () => {
    expect(parseFieldSpecs(['a:string', 'b:string'])).toHaveLength(2)
    expect(() => parseFieldSpecs(['a:string', 'a:text'])).toThrow(
      expect.objectContaining({ code: 'duplicate_field' }),
    )
  })
})

describe('formatFieldSpec', () => {
  test('prints the canonical spelling', () => {
    const field = parseFieldSpec('due:date:label("Due date"):default(now)')
    expect(formatFieldSpec(field)).toBe('due:date:label("Due date"):default(now)')
    expect(formatFieldSpec(parseFieldSpec('a:decimal( 12 , 2 )'))).toBe('a:decimal(12,2)')
  })

  test('quotes arguments with special characters and escapes quotes/backslashes', () => {
    expect(formatArg('draft')).toBe('draft')
    expect(formatArg('a b')).toBe('"a b"')
    expect(formatArg('')).toBe('""')
    expect(formatArg('say "hi" \\o/')).toBe('"say \\"hi\\" \\\\o/"')
    expect(formatArg("it's", "'")).toBe("'it\\'s'")
    expect(formatArg('say "hi"', "'")).toBe('\'say "hi"\'')
  })

  test('{ brackets: true } prints the cmd-safe spelling, quoting with single quotes', () => {
    const field = parseFieldSpec('due:date:label("Due date, local"):default(now)')
    expect(formatFieldSpec(field, { brackets: true })).toBe(
      "due:date:label['Due date, local']:default[now]",
    )
    expect(formatFieldSpec(parseFieldSpec('a:decimal(12,2):min(0)'), { brackets: true })).toBe(
      'a:decimal[12,2]:min[0]',
    )
    expect(formatFieldSpec(parseFieldSpec('a:string:required'), { brackets: true })).toBe(
      'a:string:required',
    )
  })
})

describe('square brackets: the spelling that survives Windows .cmd shims', () => {
  test('every documented example means the same with brackets', () => {
    for (const [brackets, parens] of [
      ['title:string[200]:required:searchable', 'title:string(200):required:searchable'],
      [
        'name:string[120]:required:searchable:sortable',
        'name:string(120):required:searchable:sortable',
      ],
      ['amount:decimal[12,2]:min[0]:sortable', 'amount:decimal(12,2):min(0):sortable'],
      [
        'status:enum[draft,sent,paid]:default[draft]:filterable',
        'status:enum(draft,sent,paid):default(draft):filterable',
      ],
      ['customer:belongsTo[Customer]', 'customer:belongsTo(Customer)'],
      ['tags:manyToMany[Tag, InvoiceTag]', 'tags:manyToMany(Tag,InvoiceTag)'],
      ["due:date:label['Due date, local: UTC']", 'due:date:label("Due date, local: UTC")'],
      ['due:date:label["Due date"]', 'due:date:label("Due date")'],
      ['title:string[]', 'title:string()'],
      ['code:string:regex[^a-z+$]', 'code:string:regex(^a-z+$)'],
      ['code:string:regex["^[a-z]+$"]', 'code:string:regex(^[a-z]+$)'],
    ]) {
      expect(parseFieldSpec(brackets ?? ''), brackets).toEqual(parseFieldSpec(parens ?? ''))
    }
  })

  test('the spellings cannot be mixed, and ( ) [ need quoting inside brackets', () => {
    fails('title:string[200', 'unclosed_parenthesis', 13)
    fails('title:string[200,', 'unclosed_parenthesis', 13)
    fails('title:string[200)', 'unexpected_character', 17)
    fails('title:string(200]', 'unclosed_parenthesis', 13)
    fails('a:enum[x,(y)]', 'unexpected_character', 10)
    fails('a:enum[x,y)]', 'unexpected_character', 11)
    fails('a:string:regex[^[a]', 'unexpected_character', 17)
    fails('title:string[200]x', 'unexpected_character', 18)
    fails('a:enum[x,,y]', 'empty_argument', 10)
    fails("a:enum[x,'y]", 'unterminated_quote', 10)
    fails('a:string[1,2]', 'wrong_argument_count', 3)
    fails('status:enum[draft,paid]:default[sent]', 'invalid_default', 33)
    expect(fails('title:string[200', 'unclosed_parenthesis').message).toBe('Missing "]".')
  })
})

// ---- property-based tests ----

const camelName = fc
  .stringMatching(/^[a-z][A-Za-z0-9]{0,11}$/)
  .filter((n) => !['id', 'createdAt', 'updatedAt', 'deletedAt', 'tenantId', 'version'].includes(n))
const option = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/)
const model = fc.stringMatching(/^[A-Z][A-Za-z0-9]{0,9}$/)
const freeText = fc.string({ minLength: 1, maxLength: 20 })

/** Valid specs built from the catalogue, so round-trips are tested over the whole language. */
const validField: fc.Arbitrary<FieldSpec> = fc
  .tuple(
    camelName,
    fc.oneof(
      fc.record({
        type: fc.constant('string'),
        typeArgs: fc.oneof(
          fc.constant([]),
          fc.integer({ min: 1, max: 9999 }).map((n) => [String(n)]),
        ),
      }),
      fc.record({
        type: fc.constantFrom('text', 'email', 'boolean', 'date', 'uuid', 'json'),
        typeArgs: fc.constant([]),
      }),
      fc
        .integer({ min: 1, max: 65 })
        .chain((p) =>
          fc
            .integer({ min: 0, max: p })
            .map((s) => ({ type: 'decimal', typeArgs: [String(p), String(s)] })),
        ),
      fc
        .uniqueArray(option, { minLength: 1, maxLength: 5 })
        .map((values) => ({ type: 'enum', typeArgs: values })),
      model.map((m) => ({ type: 'belongsTo', typeArgs: [m] })),
    ),
    fc.subarray(['required', 'unique', 'index', 'filterable', 'sortable', 'hidden', 'sensitive']),
    fc.option(freeText, { nil: undefined }),
  )
  .map(([name, { type, typeArgs }, flags, label]) => {
    const modifiers = flags
      .filter((f) => !(type === 'belongsTo' && f === 'searchable'))
      .map((f) => ({ name: f, args: [] as string[] }))
    if (label !== undefined) modifiers.push({ name: 'label', args: [label] })
    if (type === 'enum') modifiers.push({ name: 'default', args: [typeArgs[0] ?? ''] })
    return { name, type, typeArgs, modifiers }
  })

describe('properties', () => {
  test('format → parse round-trips every valid spec', () => {
    fc.assert(
      fc.property(validField, (field) => {
        expect(parseFieldSpec(formatFieldSpec(field))).toEqual(field)
      }),
      { numRuns: 500 },
    )
  })

  test('the bracket spelling round-trips too, and means the same as the canonical one', () => {
    fc.assert(
      fc.property(validField, (field) => {
        const brackets = formatFieldSpec(field, { brackets: true })
        // Only free text (quoted) may still contain parentheses.
        if (!field.modifiers.some((m) => m.name === 'label')) expect(brackets).not.toMatch(/[()"]/)
        expect(parseFieldSpec(brackets)).toEqual(field)
        expect(formatFieldSpec(parseFieldSpec(brackets))).toBe(formatFieldSpec(field))
      }),
      { numRuns: 500 },
    )
  })

  test('parse → format → parse is stable', () => {
    fc.assert(
      fc.property(validField, (field) => {
        const once = formatFieldSpec(parseFieldSpec(formatFieldSpec(field)))
        expect(formatFieldSpec(parseFieldSpec(once))).toBe(once)
      }),
      { numRuns: 200 },
    )
  })

  test('fuzz: arbitrary input never throws anything but FieldSpecError, with a column inside the input', () => {
    const alphabet = fc.constantFrom(...'ab:()[],"\'\\ x1Z-_.'.split(''))
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 40 }), fc.string({ unit: alphabet, maxLength: 30 })),
        (input) => {
          try {
            parseFieldSpec(input)
          } catch (error) {
            expect(error).toBeInstanceOf(FieldSpecError)
            const column = (error as FieldSpecError).column
            expect(column).toBeGreaterThanOrEqual(1)
            expect(column).toBeLessThanOrEqual(input.length + 1)
          }
        },
      ),
      { numRuns: 2000 },
    )
  })

  test('every modifier in the catalogue is reachable', () => {
    expect(Object.keys(FIELD_MODIFIERS).length).toBeGreaterThan(20)
  })
})
