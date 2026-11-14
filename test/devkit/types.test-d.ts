// Type-level tests: a line marked `@ts-expect-error` FAILS the run if it ever starts compiling,
// which proves the public API rejects that misuse.
import type {
  InstallConfig,
  InstallContext,
  InstallDeps,
  InstallEnv,
  Installer,
  InstallFs,
} from '@strutvane/contracts'
import { describe, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import {
  type ConfigPatcher,
  type DepsEditor,
  type DevkitInstallContext,
  type DevkitInstaller,
  type DevkitIo,
  defineGenerator,
  defineInstaller,
  type EnvEditor,
  looksSecret,
  nodeIo,
  type RecoveryPlan,
  recoverTransactions,
  type StagedFs,
} from '../src/index.ts'

describe('contract compatibility', () => {
  test('devkit editors can be used wherever the contracts expect the plain interfaces', () => {
    expectTypeOf<StagedFs>().toExtend<InstallFs>()
    expectTypeOf<EnvEditor>().toExtend<InstallEnv>()
    expectTypeOf<DepsEditor>().toExtend<InstallDeps>()
    expectTypeOf<ConfigPatcher>().toExtend<InstallConfig>()
    expectTypeOf<DevkitInstallContext>().toExtend<InstallContext>()
    expectTypeOf<DevkitInstaller>().toExtend<Installer>()
  })

  test('an installer written against the plain contract is accepted', () => {
    const plain: Installer = { name: 'plain', install: async () => {} }
    expectTypeOf(defineInstaller(plain)).toExtend<Installer>()
  })
})

describe('defineInstaller', () => {
  test('hooks receive the richer devkit context', () => {
    defineInstaller({
      name: 'typed',
      async install(ctx) {
        expectTypeOf(ctx.fs.remove).toBeFunction()
        expectTypeOf(ctx.env.ensure).returns.resolves.toEqualTypeOf<{
          readonly added: readonly string[]
          readonly kept: readonly string[]
        }>()
      },
    })
  })

  test('an installer needs a name and an install hook', () => {
    // @ts-expect-error install is required
    defineInstaller({ name: 'x' })
    // @ts-expect-error name is required
    defineInstaller({ install: async () => {} })
  })

  test('the env editor refuses non-string values', () => {
    defineInstaller({
      name: 'x',
      async install({ env }) {
        // @ts-expect-error values are strings
        await env.add('S', [{ key: 'PORT', value: 3000 }])
      },
    })
  })
})

describe('defineGenerator', () => {
  test('the files() input is inferred from the schema', () => {
    defineGenerator({
      name: 'typed',
      inputs: z.object({ name: z.string(), count: z.number().default(1) }),
      files: (input) => {
        expectTypeOf(input).toEqualTypeOf<{ name: string; count: number }>()
        return []
      },
    })
  })

  test('using a field the schema does not declare fails to compile', () => {
    defineGenerator({
      name: 'typed',
      inputs: z.object({ name: z.string() }),
      // @ts-expect-error `missing` is not part of the input
      files: (input) => [{ path: input.missing, content: '' }],
    })
  })
})

describe('hardening APIs', () => {
  test('a custom DevkitIo must implement the safe removal and inspection methods', () => {
    const { removeFile: _removeFile, ...withoutRemoveFile } = nodeIo
    // @ts-expect-error removeFile is required: deletions must never fall back to recursive removal
    const broken: DevkitIo = withoutRemoveFile
    expectTypeOf(broken).toEqualTypeOf<DevkitIo>()
  })

  test('diff redaction can only be turned off with an explicit boolean', () => {
    const fs = {} as StagedFs
    expectTypeOf(fs.diff)
      .parameter(0)
      .toEqualTypeOf<{ readonly revealSecrets?: boolean } | undefined>()
    // @ts-expect-error a truthy string is not an opt-out
    void fs.diff({ revealSecrets: 'yes' })
  })

  test('recovery accepts a confirmed plan and still returns a count', () => {
    const plan = {} as RecoveryPlan
    expectTypeOf(
      recoverTransactions({ io: nodeIo, projectRoot: '.', confirmed: plan }),
    ).resolves.toEqualTypeOf<number>()
    expectTypeOf(looksSecret).toEqualTypeOf<(key: string, value?: string) => boolean>()
  })
})
