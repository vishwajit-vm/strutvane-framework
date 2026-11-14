/** Generators: typed Standard Schema inputs, plain-function templates, staged writes. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import { type DevkitError, GeneratorInputError } from '../src/errors.ts'
import { defineGenerator, type Generator, runGenerator, validateInput } from '../src/generator.ts'
import { faultyIo, readFile, rejectionOf, snapshot, tempProject, writeFiles } from './helpers.ts'

const modelGenerator = defineGenerator({
  name: 'model',
  description: 'Create a model file',
  inputs: z.object({
    name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'must be PascalCase'),
    fields: z.array(z.string().regex(/^[a-z][A-Za-z0-9]*$/)).default([]),
  }),
  files: ({ name, fields }) => [
    {
      path: `app/models/${name.toLowerCase()}.model.ts`,
      content: `export const ${name} = defineModel({\n${fields.map((f) => `  ${f}: text(),\n`).join('')}})\n`,
    },
  ],
})

let projectRoot: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
})
afterEach(() => cleanup())

describe('runGenerator', () => {
  test('validates input, writes typed output, and commits', async () => {
    const result = await runGenerator(
      modelGenerator,
      { name: 'Invoice', fields: ['number'] },
      {
        projectRoot,
      },
    )
    expect(result).toMatchObject({ generator: 'model', dryRun: false })
    expect(await readFile(projectRoot, 'app/models/invoice.model.ts')).toBe(
      'export const Invoice = defineModel({\n  number: text(),\n})\n',
    )
  })

  test('dry run returns a diff and writes nothing', async () => {
    const result = await runGenerator(
      modelGenerator,
      { name: 'Invoice' },
      {
        projectRoot,
        dryRun: true,
      },
    )
    expect(result.diff).toContain('+++ b/app/models/invoice.model.ts')
    expect(await snapshot(projectRoot)).toEqual({})
  })

  test('invalid input lists every issue with its path, and nothing is written', async () => {
    const error = await rejectionOf(
      runGenerator(modelGenerator, { name: 'invoice', fields: ['Bad'] }, { projectRoot }),
    )
    expect(error).toBeInstanceOf(GeneratorInputError)
    const issues = (error as GeneratorInputError).issues
    expect(issues.map((i) => i.path)).toEqual([['name'], ['fields', 0]])
    expect(issues[0]?.message).toBe('must be PascalCase')
    expect((error as Error).message).toMatch(/name: must be PascalCase; fields\.0:/)
    expect(await snapshot(projectRoot)).toEqual({})
  })

  test('input with code-like strings is data, never executed', async () => {
    const echo = defineGenerator({
      name: 'echo',
      inputs: z.object({ text: z.string() }),
      files: ({ text }) => [{ path: 'echo.txt', content: text }],
    })
    // A template-literal breakout attempt: it must land in the file as inert text.
    const payload = ['$', '{process.exit(1)}`); require("child_process")'].join('')
    await runGenerator(echo, { text: payload }, { projectRoot })
    expect(await readFile(projectRoot, 'echo.txt')).toBe(payload)
  })

  test('never overwrites an existing file unless the file opts in', async () => {
    await writeFiles(projectRoot, { 'app/models/invoice.model.ts': 'mine\n' })
    const error = await rejectionOf(
      runGenerator(modelGenerator, { name: 'Invoice' }, { projectRoot }),
    )
    expect((error as DevkitError).code).toBe('FILE_EXISTS')
    expect(await readFile(projectRoot, 'app/models/invoice.model.ts')).toBe('mine\n')

    const forced = defineGenerator({
      name: 'forced',
      inputs: z.object({}),
      files: () => [{ path: 'app/models/invoice.model.ts', content: 'theirs\n', overwrite: true }],
    })
    await runGenerator(forced, {}, { projectRoot })
    expect(await readFile(projectRoot, 'app/models/invoice.model.ts')).toBe('theirs\n')
  })

  test('a generator producing the same path twice is refused before writing', async () => {
    const dup = defineGenerator({
      name: 'dup',
      inputs: z.object({}),
      files: async () => [
        { path: 'a.ts', content: '1' },
        { path: 'a.ts', content: '2' },
      ],
    })
    const error = await rejectionOf(runGenerator(dup, {}, { projectRoot }))
    expect((error as DevkitError).code).toBe('INVALID_GENERATOR')
    expect(await snapshot(projectRoot)).toEqual({})
  })

  test('generated paths are confined to the project', async () => {
    const evil = defineGenerator({
      name: 'evil',
      inputs: z.object({ name: z.string() }),
      files: ({ name }) => [{ path: `app/${name}.ts`, content: 'x' }],
    })
    const error = await rejectionOf(runGenerator(evil, { name: '../../escape' }, { projectRoot }))
    expect((error as DevkitError).code).toBe('PATH_OUTSIDE_PROJECT')
  })

  test('a commit failure rolls back every generated file', async () => {
    const two = defineGenerator({
      name: 'two',
      inputs: z.object({}),
      files: () => [
        { path: 'a.ts', content: 'a' },
        { path: 'b.ts', content: 'b' },
      ],
    })
    const error = await rejectionOf(runGenerator(two, {}, { projectRoot, io: faultyIo(2) }))
    expect((error as DevkitError).code).toBe('TRANSACTION_ABORTED')
    expect(await snapshot(projectRoot)).toEqual({})
  })
})

describe('validateInput', () => {
  test('works with any Standard Schema v1 validator, including async ones', async () => {
    const custom = {
      '~standard': {
        version: 1 as const,
        vendor: 'custom',
        validate: async (value: unknown) =>
          typeof value === 'number'
            ? { value: value * 2 }
            : { issues: [{ message: 'expected a number' }] },
      },
    }
    expect(await validateInput('custom', custom, 21)).toBe(42)
    const error = await rejectionOf(validateInput('custom', custom, 'x'))
    expect((error as GeneratorInputError).issues).toEqual([
      { path: [], message: 'expected a number' },
    ])
    expect((error as Error).message).toMatch(/\(input\): expected a number/)
  })

  test('path segments given as objects are unwrapped', async () => {
    const custom = {
      '~standard': {
        version: 1 as const,
        vendor: 'custom',
        validate: () => ({
          issues: [{ message: 'bad', path: [{ key: 'a' }, 0, Symbol.for('s')] }],
        }),
      },
    }
    const error = await rejectionOf(validateInput('custom', custom, {}))
    expect((error as GeneratorInputError).issues[0]?.path).toEqual(['a', 0, 'Symbol(s)'])
  })
})

describe('defineGenerator', () => {
  test.each([
    ['a bad name', { name: 'Model', inputs: z.object({}), files: () => [] }],
    ['no files()', { name: 'x', inputs: z.object({}) }],
    ['inputs that are not Standard Schema', { name: 'x', inputs: { parse() {} }, files: () => [] }],
    [
      'a wrong Standard Schema version',
      { name: 'x', inputs: { '~standard': { version: 2, validate() {} } }, files: () => [] },
    ],
  ])('rejects %s', (_, value) => {
    expect(() => defineGenerator(value as unknown as Generator<unknown>)).toThrow(
      expect.objectContaining({ code: 'INVALID_GENERATOR' }),
    )
  })
})
