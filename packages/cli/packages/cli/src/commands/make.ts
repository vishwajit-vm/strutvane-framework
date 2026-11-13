/**
 * The `make:*` generators (docs/09 §3): model, resource, policy, migration, seeder, factory, test.
 *
 * Commands translate flags into generator input and hand over to {@link applyGenerator}, which
 * owns `--dry-run`, `--diff`, `--force`, idempotency and the registry refresh.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AnyCommand, type CommandContext, defineCommand } from '../framework/command.ts'
import { CliError, usageError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { applyGenerator } from '../make/apply.ts'
import {
  type FieldSpec,
  FieldSpecError,
  formatArg,
  parseFieldSpec,
  parseFieldSpecs,
} from '../make/fields.ts'
import {
  factoryGenerator,
  migrationGenerator,
  migrationTimestamp,
  modelGenerator,
  policyGenerator,
  resourceGenerator,
  seederGenerator,
  testGenerator,
} from '../make/generators.ts'
import { type Names, names } from '../make/names.ts'
import { paths } from '../make/templates.ts'
import { analyzeFile } from '../registry/analyze.ts'
import { CONVENTIONS } from '../registry/conventions.ts'

/** Turn a field-spec error into a CLI validation error with the column. */
export function fieldError(error: FieldSpecError): CliError {
  return new CliError('INVALID_FIELD', {
    exitCode: EXIT.VALIDATION,
    params: { spec: error.spec, detail: `${error.message} (column ${error.column})` },
    issues: [
      {
        path: [error.spec],
        code: error.code,
        message: `${error.message} (column ${error.column})`,
      },
    ],
  })
}

/** Parse field specs, mapping errors to {@link fieldError}. */
function parseFields(specs: readonly string[]): FieldSpec[] {
  try {
    return parseFieldSpecs(specs)
  } catch (error) {
    if (error instanceof FieldSpecError) throw fieldError(error)
    throw error
  }
}

/** Split `--actions approve,send` (or repeated flags) into a clean list. */
function list(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

/** Validate a model name argument (PascalCase after normalisation). */
function modelNames(input: string): Names {
  return names(input, 'Model name')
}

/** The model must exist for generators that build on it. */
function requireModel(ctx: CommandContext, n: Names): string {
  const root = ctx.requireProject().root
  const path = paths.model(n)
  const file = join(root, path)
  if (!existsSync(file)) {
    throw new CliError('MODEL_NOT_FOUND', {
      exitCode: EXIT.VALIDATION,
      params: { model: n.pascal, path },
    })
  }
  return file
}

/**
 * Read an existing model's fields back into specs (for `make:factory`), using the same static
 * analysis as the registry. Only names and types are recoverable; that is all a factory needs.
 */
function existingFields(
  file: string,
  relPath: string,
): { fields: FieldSpec[]; softDeletes: boolean } {
  const convention = CONVENTIONS.find((c) => c.kind === 'model')
  if (convention === undefined) return { fields: [], softDeletes: false }
  const analysis = analyzeFile(
    { kind: 'model', relPath, absPath: file, convention },
    readFileSync(file, 'utf8'),
  )
  const model = analysis.entries.find((e) => e.kind === 'model')
  if (model === undefined || model.kind !== 'model') return { fields: [], softDeletes: false }
  const fields = model.fieldDetails.flatMap((f): FieldSpec[] => {
    if (f.type === undefined) return []
    const typeArgs = f.target !== undefined ? [f.target] : (f.values ?? [])
    try {
      // Re-validate through the parser, so only catalogue types reach the template.
      return [
        parseFieldSpec(
          `${f.name}:${f.type}${typeArgs.length > 0 ? `(${typeArgs.map(formatArg).join(',')})` : ''}`,
        ),
      ]
    } catch {
      return []
    }
  })
  return { fields, softDeletes: model.softDeletes }
}

/** The interactive field builder: one spec per prompt, validated as you type. */
async function promptFields(ctx: CommandContext): Promise<string[]> {
  const specs: string[] = []
  for (;;) {
    const spec = await ctx.prompt.text(
      'Add a field (name:type[:modifier…]), or press Enter to finish',
      {
        default: '',
        placeholder: 'title:string(200):required',
        validate(value) {
          if (value.trim() === '') return undefined
          try {
            parseFieldSpecs([...specs, value.trim()])
            return undefined
          } catch (error) {
            return error instanceof FieldSpecError
              ? `${error.message} (column ${error.column})`
              : String(error)
          }
        },
      },
    )
    if (spec.trim() === '') return specs
    specs.push(spec.trim())
  }
}

export const makeModelCommand: AnyCommand = defineCommand({
  name: 'make:model',
  description: 'Create a model with its policy, factory, seeder and feature test',
  details: [
    'Fields use the syntax name:type[(args)][:modifier[(args)]]…, for example:',
    '  title:string(200):required:searchable',
    '  amount:decimal(12,2):min(0):sortable',
    '  "status:enum(draft,sent,paid):default(draft)"   (quote arguments with parentheses in shells)',
    '  customer:belongsTo(Customer)',
    'Without fields (in a terminal) an interactive field builder opens.',
  ].join('\n'),
  args: {
    name: { required: true, description: 'Model name, e.g. Invoice or invoice-line' },
    fields: { variadic: true, description: 'Field specs' },
  },
  flags: {
    all: { type: 'boolean', description: 'Also create the resource (API/UI behaviour) file' },
    policy: {
      type: 'boolean',
      default: true,
      description: 'Create the policy (--no-policy to skip)',
    },
    factory: { type: 'boolean', default: true, description: 'Create the factory' },
    seeder: { type: 'boolean', default: true, description: 'Create the seeder' },
    test: { type: 'boolean', default: true, description: 'Create the feature test' },
    api: {
      type: 'boolean',
      default: true,
      description: 'Expose the CRUD API (--no-api to disable)',
    },
    ui: { type: 'boolean', default: true, description: 'Generate UI screens (--no-ui to disable)' },
    tenant: {
      type: 'boolean',
      description: 'Scope rows to the tenant (--no-tenant for global data)',
    },
    audit: { type: 'boolean', default: false, description: 'Record changes in the audit log' },
    'soft-deletes': { type: 'boolean', default: false, description: 'Delete by setting deletedAt' },
    timestamps: { type: 'boolean', default: true, description: 'Add createdAt/updatedAt' },
    seed: {
      type: 'string',
      valueName: '<n>',
      default: '10',
      description: 'Rows the seeder creates',
    },
  },
  examples: [
    'sv make:model Invoice number:string:unique amount:decimal(12,2):min(0) customer:belongsTo(Customer)',
    'sv make model Tag name:string:required --no-seeder --dry-run --diff',
  ],
  async run(ctx) {
    const n = modelNames(ctx.args.name)
    const specs =
      ctx.args.fields.length === 0 && ctx.prompt.interactive
        ? await promptFields(ctx)
        : ctx.args.fields
    const fields = parseFields(specs)
    const seedCount = Number(ctx.flags.seed)
    if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > 100_000) {
      throw usageError('INVALID_FLAG_VALUE', {
        detail: '--seed must be a whole number from 1 to 100000.',
        command: ctx.command,
      })
    }
    const data = await applyGenerator(
      ctx,
      modelGenerator,
      {
        name: n.pascal,
        fields,
        options: {
          timestamps: ctx.flags.timestamps,
          softDeletes: ctx.flags['soft-deletes'],
          ...(ctx.flags.tenant === undefined ? {} : { tenant: ctx.flags.tenant }),
          audit: ctx.flags.audit,
          api: ctx.flags.api,
          ui: ctx.flags.ui,
        } as Parameters<typeof modelGenerator.files>[0]['options'],
        with: {
          policy: ctx.flags.policy,
          factory: ctx.flags.factory,
          seeder: ctx.flags.seeder,
          test: ctx.flags.test,
          resource: ctx.flags.all === true,
        },
        seedCount,
      },
      'sv migrate',
    )
    return { data: { model: n.pascal, fields, ...data } }
  },
})

export const makeResourceCommand: AnyCommand = defineCommand({
  name: 'make:resource',
  description: 'Create the resource file (custom actions and hooks) for a model',
  args: { model: { required: true, description: 'Model name' } },
  flags: {
    actions: {
      type: 'string',
      valueName: '<a,b>',
      description: 'Custom actions, e.g. approve,send',
    },
    hooks: {
      type: 'string',
      valueName: '<a,b>',
      description: 'Lifecycle hooks, e.g. beforeCreate,afterUpdate',
    },
  },
  examples: ['sv make:resource Invoice --actions approve,send --hooks beforeCreate'],
  async run(ctx) {
    const n = modelNames(ctx.args.model)
    requireModel(ctx, n)
    const data = await applyGenerator(ctx, resourceGenerator, {
      model: n.pascal,
      actions: list(ctx.flags.actions),
      hooks: list(ctx.flags.hooks),
    })
    return { data }
  },
})

export const makePolicyCommand: AnyCommand = defineCommand({
  name: 'make:policy',
  description: 'Create a deny-by-default policy for a model',
  args: { model: { required: true, description: 'Model name' } },
  flags: {
    template: {
      type: 'string',
      default: 'default',
      choices: ['default', 'owner', 'tenant-admin', 'readonly'],
      description: 'Starting rules',
    },
  },
  examples: ['sv make:policy Invoice --template owner'],
  async run(ctx) {
    const n = modelNames(ctx.args.model)
    const file = requireModel(ctx, n)
    const { softDeletes } = existingFields(file, paths.model(n))
    const data = await applyGenerator(ctx, policyGenerator, {
      model: n.pascal,
      template: ctx.flags.template as 'default' | 'owner' | 'tenant-admin' | 'readonly',
      softDeletes,
    })
    return { data }
  },
})

export const makeFactoryCommand: AnyCommand = defineCommand({
  name: 'make:factory',
  description: "Create a factory with fake data matching a model's field types",
  args: { model: { required: true, description: 'Model name' } },
  examples: ['sv make:factory Invoice'],
  async run(ctx) {
    const n = modelNames(ctx.args.model)
    const file = requireModel(ctx, n)
    const { fields } = existingFields(file, paths.model(n))
    const data = await applyGenerator(ctx, factoryGenerator, { model: n.pascal, fields })
    return { data }
  },
})

export const makeSeederCommand: AnyCommand = defineCommand({
  name: 'make:seeder',
  description: 'Create a database seeder',
  args: { name: { required: true, description: 'Seeder name, e.g. Invoice or DemoData' } },
  flags: {
    model: {
      type: 'string',
      valueName: '<Model>',
      description: 'Seed this model with its factory',
    },
    count: { type: 'string', valueName: '<n>', default: '10', description: 'Rows to create' },
  },
  examples: ['sv make:seeder Invoice --model Invoice --count 50'],
  async run(ctx) {
    const n = names(ctx.args.name, 'Seeder name')
    const model = ctx.flags.model === undefined ? undefined : modelNames(ctx.flags.model)
    const count = Number(ctx.flags.count)
    if (!Number.isInteger(count) || count < 1 || count > 100_000) {
      throw usageError('INVALID_FLAG_VALUE', {
        detail: '--count must be a whole number from 1 to 100000.',
        command: ctx.command,
      })
    }
    const data = await applyGenerator(ctx, seederGenerator, {
      name: n.pascal,
      model: model?.pascal,
      count,
    })
    return { data }
  },
})

export const makeTestCommand: AnyCommand = defineCommand({
  name: 'make:test',
  description: 'Create a feature (default), unit or end-to-end test',
  args: { name: { required: true, description: 'Test name, e.g. invoice-totals' } },
  flags: {
    unit: { type: 'boolean', description: 'A unit test (tests/unit/)' },
    e2e: { type: 'boolean', description: 'A Playwright end-to-end test (tests/e2e/)' },
    model: { type: 'string', valueName: '<Model>', description: 'Import this model in the test' },
  },
  examples: ['sv make:test invoice-totals --unit --model Invoice'],
  async run(ctx) {
    if (ctx.flags.unit === true && ctx.flags.e2e === true) {
      throw usageError('INVALID_ARGUMENT', { detail: 'Choose one of --unit and --e2e.' })
    }
    const kind = ctx.flags.unit === true ? 'unit' : ctx.flags.e2e === true ? 'e2e' : 'feature'
    const n = names(ctx.args.name, 'Test name')
    const model = ctx.flags.model === undefined ? undefined : modelNames(ctx.flags.model)
    const data = await applyGenerator(ctx, testGenerator, {
      name: n.kebab,
      kind,
      model: model?.pascal,
    })
    return { data }
  },
})

export const makeMigrationCommand: AnyCommand = defineCommand({
  name: 'make:migration',
  description: 'Create a hand-written migration stub (data changes, special DDL)',
  details: 'Model changes do not need this: `sv migrate` diffs models against the database.',
  args: {
    name: { required: true, description: 'snake_case description, e.g. backfill_invoice_totals' },
  },
  flags: {
    sql: { type: 'boolean', description: 'A raw .sql file instead of TypeScript' },
    table: { type: 'string', valueName: '<table>', description: 'Pre-fill an alterTable() block' },
  },
  examples: ['sv make:migration backfill_invoice_totals --table invoices'],
  async run(ctx) {
    const name = names(ctx.args.name, 'Migration name').snake
    const data = await applyGenerator(
      ctx,
      migrationGenerator,
      {
        name,
        timestamp: migrationTimestamp(ctx.services.clock.now()),
        sql: ctx.flags.sql === true,
        table: ctx.flags.table,
      },
      'sv migrate',
    )
    return { data }
  },
})
