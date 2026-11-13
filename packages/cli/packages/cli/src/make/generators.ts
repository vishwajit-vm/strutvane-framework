/**
 * The `make:*` generators, declared with `@strutvane/devkit`'s `defineGenerator`.
 *
 * Each generator validates its input with a Zod schema (Standard Schema, so devkit reports every
 * problem as an RFC-0003 issue) and returns the files to write. The commands only collect input;
 * staging, `--dry-run`, diffs and the all-or-nothing commit are devkit's. Exporting the generators
 * lets other tools (an IDE extension, `create-strutvane`) produce exactly what `sv make:*` does.
 *
 * @module
 */
import { defineGenerator, type Generator } from '@strutvane/devkit'
import { z } from 'zod'
import type { FieldSpec } from './fields.ts'
import { names } from './names.ts'
import {
  factoryTemplate,
  featureTestTemplate,
  type ModelOptions,
  migrationTemplate,
  modelTemplate,
  type PolicyTemplate,
  paths,
  policyTemplate,
  RESOURCE_HOOKS,
  resourceTemplate,
  seederTemplate,
  type TestKind,
  testTemplate,
} from './templates.ts'

const PascalName = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'must be a PascalCase name')
const Field: z.ZodType<FieldSpec> = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  type: z.string().min(1),
  typeArgs: z.array(z.string()),
  modifiers: z.array(z.object({ name: z.string().min(1), args: z.array(z.string()) })),
})

/** Input of the model generator. */
export interface ModelGeneratorInput {
  readonly name: string
  readonly fields: readonly FieldSpec[]
  readonly options: ModelOptions
  /** Which companion files to create besides the model. */
  readonly with: {
    readonly policy: boolean
    readonly factory: boolean
    readonly seeder: boolean
    readonly test: boolean
    readonly resource: boolean
  }
  readonly seedCount: number
}

const ModelInput: z.ZodType<ModelGeneratorInput> = z.object({
  name: PascalName,
  fields: z.array(Field),
  options: z.object({
    timestamps: z.boolean(),
    softDeletes: z.boolean(),
    tenant: z.boolean().optional(),
    audit: z.boolean(),
    api: z.boolean(),
    ui: z.boolean(),
  }) as z.ZodType<ModelOptions>,
  with: z.object({
    policy: z.boolean(),
    factory: z.boolean(),
    seeder: z.boolean(),
    test: z.boolean(),
    resource: z.boolean(),
  }),
  seedCount: z.number().int().min(1).max(100_000),
})

/** `make:model`: the model plus its policy, factory, seeder, feature test (and resource). */
export const modelGenerator: Generator<ModelGeneratorInput> = defineGenerator({
  name: 'model',
  description: 'A model with its policy, factory, seeder and feature test',
  inputs: ModelInput,
  files(input) {
    const n = names(input.name)
    const files = [{ path: paths.model(n), content: modelTemplate(n, input.fields, input.options) }]
    if (input.with.policy) {
      files.push({
        path: paths.policy(n),
        content: policyTemplate(n, 'default', input.options.softDeletes),
      })
    }
    if (input.with.resource)
      files.push({ path: paths.resource(n), content: resourceTemplate(n, [], []) })
    if (input.with.factory)
      files.push({ path: paths.factory(n), content: factoryTemplate(n, input.fields) })
    if (input.with.seeder) {
      files.push({ path: paths.seeder(n), content: seederTemplate(n, n, input.seedCount) })
    }
    if (input.with.test) {
      files.push({
        path: paths.featureTest(n),
        content: featureTestTemplate(n, { api: input.options.api }),
      })
    }
    return files
  },
})

/** Input of the resource generator. */
export interface ResourceGeneratorInput {
  readonly model: string
  readonly actions: readonly string[]
  readonly hooks: readonly string[]
}

/** `make:resource`. */
export const resourceGenerator: Generator<ResourceGeneratorInput> = defineGenerator({
  name: 'resource',
  inputs: z.object({
    model: PascalName,
    actions: z.array(z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'actions are lower camelCase')),
    hooks: z.array(
      z.string().refine((h) => RESOURCE_HOOKS.includes(h), {
        message: `hooks are: ${RESOURCE_HOOKS.join(', ')}`,
      }),
    ),
  }),
  files(input) {
    const n = names(input.model)
    return [{ path: paths.resource(n), content: resourceTemplate(n, input.actions, input.hooks) }]
  },
})

/** Input of the policy generator. */
export interface PolicyGeneratorInput {
  readonly model: string
  readonly template: PolicyTemplate
  readonly softDeletes: boolean
}

/** `make:policy`. */
export const policyGenerator: Generator<PolicyGeneratorInput> = defineGenerator({
  name: 'policy',
  inputs: z.object({
    model: PascalName,
    template: z.enum(['default', 'owner', 'tenant-admin', 'readonly']),
    softDeletes: z.boolean(),
  }),
  files(input) {
    const n = names(input.model)
    return [
      { path: paths.policy(n), content: policyTemplate(n, input.template, input.softDeletes) },
    ]
  },
})

/** Input of the factory generator. */
export interface FactoryGeneratorInput {
  readonly model: string
  readonly fields: readonly FieldSpec[]
}

/** `make:factory`. */
export const factoryGenerator: Generator<FactoryGeneratorInput> = defineGenerator({
  name: 'factory',
  inputs: z.object({ model: PascalName, fields: z.array(Field) }),
  files(input) {
    const n = names(input.model)
    return [{ path: paths.factory(n), content: factoryTemplate(n, input.fields) }]
  },
})

/** Input of the seeder generator. */
export interface SeederGeneratorInput {
  readonly name: string
  readonly model: string | undefined
  readonly count: number
}

/** `make:seeder`. */
export const seederGenerator: Generator<SeederGeneratorInput> = defineGenerator({
  name: 'seeder',
  inputs: z.object({
    name: PascalName,
    model: PascalName.optional(),
    count: z.number().int().min(1).max(100_000),
  }) as z.ZodType<SeederGeneratorInput>,
  files(input) {
    const n = names(input.name)
    const model = input.model === undefined ? undefined : names(input.model)
    return [{ path: paths.seeder(n), content: seederTemplate(n, model, input.count) }]
  },
})

/** Input of the test generator. */
export interface TestGeneratorInput {
  readonly name: string
  readonly kind: TestKind
  readonly model: string | undefined
}

/** `make:test`. */
export const testGenerator: Generator<TestGeneratorInput> = defineGenerator({
  name: 'test',
  inputs: z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    kind: z.enum(['feature', 'unit', 'e2e']),
    model: PascalName.optional(),
  }) as z.ZodType<TestGeneratorInput>,
  files(input) {
    const n = names(input.name)
    const model = input.model === undefined ? undefined : names(input.model)
    return [{ path: paths.test(n, input.kind), content: testTemplate(n, input.kind, model) }]
  },
})

/** Input of the migration generator. */
export interface MigrationGeneratorInput {
  readonly name: string
  /** `YYYYMMDDHHmmss` (UTC). */
  readonly timestamp: string
  readonly sql: boolean
  readonly table: string | undefined
}

/** `make:migration`. */
export const migrationGenerator: Generator<MigrationGeneratorInput> = defineGenerator({
  name: 'migration',
  inputs: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'use snake_case, e.g. add_status_to_invoices'),
    timestamp: z.string().regex(/^\d{14}$/),
    sql: z.boolean(),
    table: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/, 'table names are snake_case')
      .optional(),
  }) as z.ZodType<MigrationGeneratorInput>,
  files(input) {
    return [
      {
        path: paths.migration(input.timestamp, input.name, input.sql),
        content: migrationTemplate(input.name, { sql: input.sql, table: input.table }),
      },
    ]
  },
})

/** `YYYYMMDDHHmmss` in UTC, for migration file names. */
export function migrationTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:T]/g, '').slice(0, 14)
}
