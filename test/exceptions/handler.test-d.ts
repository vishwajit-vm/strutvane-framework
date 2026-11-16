/**
 * `withExceptions()` types: class-specific callbacks get that class, renderers must return a
 * Response or undefined.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { ExceptionsConfig } from '../../src/exceptions/handler.ts'

class PaymentDeclined extends Error {
  readonly invoiceId = 7
}

describe('withExceptions() types', () => {
  it('withExceptions() callbacks get the class they registered for', () => {
    const configure = (e: ExceptionsConfig): void => {
      e.render(PaymentDeclined, (error) => {
        expectTypeOf(error).toEqualTypeOf<PaymentDeclined>()
        return Response.json({ invoice: error.invoiceId }, { status: 402 })
      })
      e.report(PaymentDeclined, (error) => expectTypeOf(error.invoiceId).toEqualTypeOf<number>())
      e.render((error) => {
        expectTypeOf(error).toEqualTypeOf<unknown>()
        return undefined
      })
      // @ts-expect-error a renderer returns a Response or undefined
      e.render(PaymentDeclined, () => 'nope')
    }
    void configure
  })
})
