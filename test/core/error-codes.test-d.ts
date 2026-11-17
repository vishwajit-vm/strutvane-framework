// Type-level tests for the lowercase error codes (CONSISTENCY #123): the well-known codes are
// lowercase, the old uppercase names are not codes any more, and the compatibility helper maps an
// old name to its exact new name.
import { describe, expectTypeOf, test } from 'vitest'
import type { ProblemCode } from '../../src/contracts/index.ts'
import { currentErrorCode, type LegacyProblemCode } from '../../src/core/index.ts'

describe('ProblemCode', () => {
  test('is lowercase snake_case', () => {
    expectTypeOf<'not_found'>().toExtend<ProblemCode>()
    expectTypeOf<'validation_failed'>().toExtend<ProblemCode>()
    expectTypeOf<ProblemCode>().toEqualTypeOf<Lowercase<ProblemCode>>()
  })

  test('the old uppercase names do not compile as a ProblemCode', () => {
    // @ts-expect-error renamed to 'not_found' in 0.2
    const old: ProblemCode = 'NOT_FOUND'
    // @ts-expect-error renamed to 'validation_failed' in 0.2
    const older: ProblemCode = 'VALIDATION_FAILED'
    void old
    void older
  })
})

describe('currentErrorCode', () => {
  test('maps an old well-known name to its new literal', () => {
    expectTypeOf(currentErrorCode('NOT_FOUND')).toEqualTypeOf<'not_found'>()
    expectTypeOf(currentErrorCode('RATE_LIMITED')).toEqualTypeOf<'rate_limited'>()
    expectTypeOf<LegacyProblemCode>().toExtend<string>()
    expectTypeOf<'FORBIDDEN'>().toExtend<LegacyProblemCode>()
  })

  test('any other code stays a string', () => {
    expectTypeOf(currentErrorCode('invoice_already_paid')).toEqualTypeOf<string>()
  })
})
