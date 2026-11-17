/**
 * Facade signatures: return types flow through, misuse fails to compile, and the 0.3 facades
 * return `never`.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { CacheStore } from '../../src/cache/contract.ts'
import type { Logger } from '../../src/contracts/logger.ts'
import type { Database } from '../../src/database/types.ts'
import { Cache, Crypt, DB, Hash, Log, Mail, Route, Url } from '../../src/facades/index.ts'
import type { MatchedRoute } from '../../src/http/app/context.ts'

describe('facade types', () => {
  it('Cache keeps the type remember() computes, and get() is unknown', () => {
    expectTypeOf(Cache.remember('n', 60, () => 3)).toEqualTypeOf<Promise<number>>()
    expectTypeOf(Cache.rememberForever('s', async () => 'x')).toEqualTypeOf<Promise<string>>()
    expectTypeOf(Cache.get('k')).toEqualTypeOf<Promise<unknown>>()
    expectTypeOf(Cache.store('file')).toEqualTypeOf<CacheStore>()
    // @ts-expect-error a TTL is seconds, not a string
    void Cache.put('k', 1, '60')
  })

  it('Log takes a message and fields, and hands out a Logger', () => {
    expectTypeOf(Log.child({ module: 'billing' })).toEqualTypeOf<Logger>()
    // @ts-expect-error the message is a string
    Log.info(42)
    // @ts-expect-error no such level
    Log.verbose('x')
  })

  it('Crypt.decrypt returns unknown, DB.query rows are typed', () => {
    expectTypeOf(Crypt.decrypt('payload')).toEqualTypeOf<unknown>()
    expectTypeOf(Crypt.encryptString('x')).toEqualTypeOf<string>()
    expectTypeOf(DB.query<{ id: number }>('select id from posts')).toEqualTypeOf<
      Promise<{ id: number }[]>
    >()
    expectTypeOf(DB.connection()).toEqualTypeOf<Database>()
  })

  it('Url and Route are typed like route()', () => {
    expectTypeOf(Url.route('posts.show', { post: 7 })).toEqualTypeOf<string>()
    expectTypeOf(Route.current()).toEqualTypeOf<MatchedRoute | undefined>()
    // @ts-expect-error a route name is a string
    Url.route(7)
  })

  it('the 0.3 facades compile and return never', () => {
    expectTypeOf(Mail.send).returns.toEqualTypeOf<never>()
    expectTypeOf(Hash.make).returns.toEqualTypeOf<never>()
    // @ts-expect-error not a member of the reserved Mail facade
    Mail.later()
  })
})
