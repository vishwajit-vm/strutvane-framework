// Type-level tests for the public command API: flag and argument types are inferred from the
// declaration, and misuse fails to compile.
import { describe, expectTypeOf, test } from 'vitest'
import { type CommandOutcome, defineCommand } from '../../src/console/index.ts'

describe('defineCommand inference', () => {
  test('flags are typed from their declarations', () => {
    defineCommand({
      name: 'demo:flags',
      description: 'd',
      flags: {
        all: { type: 'boolean' },
        api: { type: 'boolean', default: true },
        seed: { type: 'string', default: '10' },
        model: { type: 'string' },
        tag: { type: 'string', multiple: true },
      },
      run(ctx) {
        expectTypeOf(ctx.flags.all).toEqualTypeOf<boolean | undefined>()
        expectTypeOf(ctx.flags.api).toEqualTypeOf<boolean>()
        expectTypeOf(ctx.flags.seed).toEqualTypeOf<string>()
        expectTypeOf(ctx.flags.model).toEqualTypeOf<string | undefined>()
        expectTypeOf(ctx.flags.tag).toEqualTypeOf<string[]>()
        // @ts-expect-error unknown flags do not exist
        void ctx.flags.nope
        return {}
      },
    })
  })

  test('arguments are typed: required → string, optional → string | undefined, variadic → string[]', () => {
    defineCommand({
      name: 'demo:args',
      description: 'd',
      args: { name: { required: true }, maybe: {}, rest: { variadic: true } },
      run(ctx) {
        expectTypeOf(ctx.args.name).toEqualTypeOf<string>()
        expectTypeOf(ctx.args.maybe).toEqualTypeOf<string | undefined>()
        expectTypeOf(ctx.args.rest).toEqualTypeOf<string[]>()
        return undefined
      },
    })
  })

  test('run may return an outcome, nothing, or a promise of either', () => {
    defineCommand({ name: 'a', description: 'd', run: () => ({ data: 1 }) })
    defineCommand({ name: 'b', description: 'd', async run() {} })
    expectTypeOf<CommandOutcome['exitCode']>().toEqualTypeOf<
      0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 130 | undefined
    >()
  })

  test('flag types are checked', () => {
    defineCommand({
      name: 'bad',
      description: 'd',
      // @ts-expect-error "number" is not a flag type
      flags: { n: { type: 'number' } },
      run: () => ({}),
    })
  })

  test('exit codes are limited to the documented ones', () => {
    // @ts-expect-error 42 is not a documented exit code
    const outcome: CommandOutcome = { exitCode: 42 }
    void outcome
  })
})
