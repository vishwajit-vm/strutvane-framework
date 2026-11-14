/**
 * Type-level tests: a custom route's `params` are typed from its path (so `c.params.id` is a
 * `string`, not `string | undefined`), and unknown params do not compile.
 */
import { describe, expectTypeOf, it } from 'vitest'
import { type RouteParams, route } from '../../src/http/route.ts'
import type { BoundFilter } from '../../src/query/bind.ts'

describe('route params types', () => {
  it('infers every :param of the path', () => {
    expectTypeOf<RouteParams<'/invoices/:id/mark-paid'>>().toEqualTypeOf<{ readonly id: string }>()
    expectTypeOf<RouteParams<'/a/:x/b/:y'>>().toEqualTypeOf<{
      readonly x: string
      readonly y: string
    }>()
    route.post('/invoices/:id/lines/:lineId', {
      handler: (c) => {
        expectTypeOf(c.params.id).toEqualTypeOf<string>()
        expectTypeOf(c.params.lineId).toEqualTypeOf<string>()
        // @ts-expect-error not a parameter of this path
        void c.params.other
        expectTypeOf(c.where).returns.toEqualTypeOf<BoundFilter>()
        return null
      },
    })
    route.get('/hello', {
      public: true,
      handler: (c) => {
        // @ts-expect-error a path without parameters has none
        void c.params.id
        return { ok: true }
      },
    })
  })
})
