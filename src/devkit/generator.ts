/**
 * Generators: the engine behind `sv make:*`.
 *
 * A generator declares its inputs as a Standard Schema validator (Zod by default) and produces
 * files from plain TypeScript functions. There is deliberately **no template engine**: no
 * `eval`, no string-to-code compilation, no template syntax that can execute code. Templates are
 * ordinary, type-checked functions, so the inputs are typed end to end.
 *
 * Generated files go through the staged file system: inputs are validated first, every file is
 * staged, and then the whole set is either previewed (`dryRun`) or committed as one transaction.
 * An existing file is never overwritten unless that file says `overwrite: true`.
 *
 * @module
 */
import type { StandardSchemaV1 } from '../contracts/index.ts'
import { DevkitError, GeneratorInputError, type InputIssue } from './errors.ts'
import type { DevkitIo } from './io.ts'
import { createStagedFs, type FileChange } from './staged-fs.ts'

/** One file a generator produces. */
export interface GeneratedFile {
  /** Project-relative POSIX path. */
  readonly path: string
  readonly content: string
  /** Replace the file if it already exists with different content. Default `false`. */
  readonly overwrite?: boolean
}

/** A generator definition. `Input` is inferred from the schema. */
export interface Generator<Input> {
  /** Kebab-case name, e.g. `model`, `resource`. */
  readonly name: string
  readonly description?: string
  /** Validates and types the raw input (CLI flags, prompt answers). */
  readonly inputs: StandardSchemaV1<unknown, Input>
  /** Produce files from validated input. Pure: no I/O. */
  files(input: Input): readonly GeneratedFile[] | Promise<readonly GeneratedFile[]>
}

/** Options for {@link runGenerator}. */
export interface RunGeneratorOptions {
  readonly projectRoot: string
  /** Preview only. Default `false`. */
  readonly dryRun?: boolean
  readonly io?: DevkitIo
}

/** What a generator run did (or would do). */
export interface GenerateResult {
  readonly generator: string
  readonly dryRun: boolean
  readonly changes: readonly FileChange[]
  readonly diff: string
}

const NAME = /^[a-z][a-z0-9-]*$/

/** Declare a generator, validating its shape early. */
export function defineGenerator<Input>(generator: Generator<Input>): Generator<Input> {
  if (typeof generator.name !== 'string' || !NAME.test(generator.name)) {
    throw new DevkitError(
      'invalid_generator',
      `generator name "${String(generator.name)}" must be lowercase kebab-case`,
    )
  }
  if (typeof generator.files !== 'function') {
    throw new DevkitError(
      'invalid_generator',
      `generator "${generator.name}" needs a files() function`,
    )
  }
  const std = (generator.inputs as Partial<StandardSchemaV1> | undefined)?.['~standard']
  if (std === undefined || std.version !== 1 || typeof std.validate !== 'function') {
    throw new DevkitError(
      'invalid_generator',
      `generator "${generator.name}": inputs must be a Standard Schema v1 validator (e.g. a Zod schema)`,
    )
  }
  return Object.freeze(generator)
}

/** Validate raw input with a Standard Schema validator, collecting every issue. */
export async function validateInput<Input>(
  name: string,
  schema: StandardSchemaV1<unknown, Input>,
  raw: unknown,
): Promise<Input> {
  const result = await schema['~standard'].validate(raw)
  if (result.issues !== undefined) {
    const issues: InputIssue[] = result.issues.map((issue) => ({
      path: (issue.path ?? []).map((segment) => {
        const key = typeof segment === 'object' && segment !== null ? segment.key : segment
        return typeof key === 'number' ? key : String(key)
      }),
      message: issue.message,
    }))
    throw new GeneratorInputError(name, issues)
  }
  return result.value
}

/** Run a generator: validate input, stage its files, then preview or commit. */
export async function runGenerator<Input>(
  generator: Generator<Input>,
  rawInput: unknown,
  options: RunGeneratorOptions,
): Promise<GenerateResult> {
  const input = await validateInput(generator.name, generator.inputs, rawInput)
  const files = await generator.files(input)
  const fs = createStagedFs(options.projectRoot, options.io === undefined ? {} : { io: options.io })
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new DevkitError(
        'invalid_generator',
        `generator "${generator.name}" produced ${file.path} twice`,
      )
    }
    seen.add(file.path)
    await fs.write(file.path, file.content, file.overwrite === true ? { overwrite: true } : {})
  }
  const changes = await fs.changes()
  const diff = await fs.diff()
  const dryRun = options.dryRun ?? false
  if (dryRun) fs.discard()
  else await fs.commit()
  return { generator: generator.name, dryRun, changes, diff }
}
