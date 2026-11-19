/**
 * The `make:*` generators (docs/09 §3): model, resource, policy, migration, seeder, factory, test.
 *
 * Commands translate flags into generator input and hand over to {@link applyGenerator}, which
 * owns `--dry-run`, `--diff`, `--force`, idempotency and the registry refresh.
 *
 * @module
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GeneratedFile } from '../../devkit/index.ts'
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
import {
  blankSeederStub,
  DATABASE_SEEDER_FILE,
  databaseSeederStub,
  factoryStub,
  isMigrationFirstProject,
  migrationFirstFiles,
  migrationFirstGenerator,
  policyStub,
  registerSeederV2,
  SEEDERS_END,
  SEEDERS_START,
  seederStub,
} from '../make/migration-first.ts'
import { type Names, names } from '../make/names.ts'
import {
  DATABASE_SEEDER_PATH,
  type RegistrationResult,
  registerSeeder,
} from '../make/seeder-registration.ts'
import { paths } from '../make/templates.ts'
import { analyzeFile } from '../registry/analyze.ts'
import { CONVENTIONS } from '../registry/conventions.ts'

/** Turn a field-spec error into a CLI validation error with the column. */
export function fieldError(error: FieldSpecError): CliError {
  return new CliError('invalid_field', {
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
    throw new CliError('model_not_found', {
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
          `${f.name}:${f.type}${typeArgs.length > 0 ? `(${typeArgs.map((a) => formatArg(a)).join(',')})` : ''}`,
        ),
      ]
    } catch {
      return []
    }
  })
  return { fields, softDeletes: model.softDeletes }
}

/**
 * The field-syntax part of `node strut help make:model`. Both spellings are always accepted; the order
 * depends on the platform because on Windows the parenthesised one breaks before the CLI even
 * runs: PowerShell strips the quotes and cmd.exe re-parses the arguments inside the `.cmd` shims
 * that npm and npx run through, where `)` ends a block ("… was unexpected at this time"). That
 * cannot be detected at runtime, so help text and docs are the guard (see `make/fields.ts`).
 */
export function fieldSyntaxDetails(platform: NodeJS.Platform): string {
  const brackets = [
    '  title:string[200]:required:searchable',
    '  amount:decimal[12,2]:min[0]:sortable',
    '  status:enum[draft,sent,paid]:default[draft]',
    '  customer:belongsTo[Customer]',
    `  "due:date:label['Due date, local']"   (quote text with spaces; single quotes inside)`,
  ]
  const parens = [
    '  title:string(200):required:searchable',
    "  'amount:decimal(12,2):min(0):sortable'   (quote parentheses in shells)",
    "  'status:enum(draft,sent,paid):default(draft)'",
    "  'customer:belongsTo(Customer)'",
  ]
  const windows = platform === 'win32'
  return [
    'Fields use the syntax name:type[:modifier]…; a type or modifier takes its arguments in',
    '[square brackets] or (parentheses), which mean the same.',
    ...(windows
      ? [
          'On Windows use square brackets: parentheses break inside the .cmd shims that npm and',
          'npx run through ("… was unexpected at this time"), even when quoted:',
          ...brackets,
          'Parentheses (fine from cmd.exe or Git Bash when quoted):',
          ...parens,
        ]
      : [
          ...parens,
          'Square brackets (use these on Windows, where parentheses break inside the .cmd shims of',
          'npm and npx; in zsh, quote them):',
          ...brackets,
        ]),
    'Without fields (in a terminal) an interactive field builder opens.',
  ].join('\n')
}

/** `node strut help make:model` examples: the cmd-safe spelling first on Windows. */
export function makeModelExamples(platform: NodeJS.Platform): string[] {
  const brackets =
    'node strut make:model Invoice number:string:unique amount:decimal[12,2]:min[0] customer:belongsTo[Customer]'
  const parens =
    "node strut make:model Invoice number:string:unique 'amount:decimal(12,2):min(0)' 'customer:belongsTo(Customer)'"
  return [
    ...(platform === 'win32' ? [brackets, parens] : [parens, brackets]),
    'node strut make model Tag name:string:required --no-seeder --dry-run --diff',
  ]
}

/** The `belongsTo` targets of every model in `app/models`, by model name (static analysis). */
function modelParents(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const convention = CONVENTIONS.find((c) => c.kind === 'model')
  if (convention === undefined) return out
  const dir = join(root, ...convention.dir.split('/'))
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(convention.suffix)) continue
    const absPath = join(dir, entry.name)
    const relPath = `${convention.dir}/${entry.name}`
    const analysis = analyzeFile(
      { kind: 'model', relPath, absPath, convention },
      readFileSync(absPath, 'utf8'),
    )
    const model = analysis.entries.find((e) => e.kind === 'model')
    if (model === undefined || model.kind !== 'model') continue
    out.set(
      model.name,
      model.fieldDetails.flatMap((f) =>
        f.type === 'belongsTo' && f.target !== undefined ? [f.target] : [],
      ),
    )
  }
  return out
}

/** A planned registration in `database.seeder.ts`. */
interface SeederPlan {
  readonly seeder: string
  /** The patched file, when it changes. */
  readonly file: GeneratedFile | undefined
  readonly result: RegistrationResult
}

/**
 * Plan registering the seeder `seeder` (which seeds `model`) in the database seeder, after the
 * seeders of the models `model` belongs to (`parents`; read from its model file when omitted) and
 * before the seeders of existing models that belong to it. Seeders are matched to models by name
 * (`<Model>Seeder`), the names `make:model` gives them.
 */
function planSeederRegistration(
  root: string,
  seeder: Names,
  model: string,
  parents?: readonly string[],
): SeederPlan {
  const relations = modelParents(root)
  const own = parents ?? relations.get(model) ?? []
  const after = [...new Set(own.filter((p) => p !== model).map((p) => `${p}Seeder`))]
  const before = [...relations]
    .filter(([name, targets]) => name !== model && targets.includes(model))
    .map(([name]) => `${name}Seeder`)
  const path = join(root, ...DATABASE_SEEDER_PATH.split('/'))
  const current =
    existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined
  const name = `${seeder.pascal}Seeder`
  const result = registerSeeder(current, {
    seeder: name,
    importPath: `./${seeder.kebab}.seeder.ts`,
    after,
    before,
  })
  const file =
    result.status === 'registered'
      ? { path: DATABASE_SEEDER_PATH, content: result.content }
      : undefined
  return { seeder: name, file, result }
}

/** Print the registration outcome; returns it for `--json`. */
function reportSeederRegistration(
  ctx: CommandContext,
  plan: SeederPlan,
  dryRun: boolean,
): Record<string, unknown> {
  const { seeder, result } = plan
  const path = DATABASE_SEEDER_PATH
  if (result.status === 'unrecognised') {
    ctx.out.warn(
      `${path} does not have the shape node strut make:model can edit, so ${seeder} was not registered. Add these lines yourself:`,
    )
    for (const line of result.manual) ctx.out.line(`  ${line}`)
    return { seeder, path, status: 'manual', manual: result.manual }
  }
  for (const missing of result.missingAfter) {
    ctx.out.warn(
      `${missing} is not registered in ${path}, so ${seeder} runs without the rows it would create. Register it before ${seeder}.`,
    )
  }
  if (result.status === 'registered') {
    const extra = result.created
      ? ' (new file)'
      : result.migrated
        ? ' (updated to the current shape)'
        : ''
    ctx.out.info(`${dryRun ? 'Would register' : 'Registered'} ${seeder} in ${path}${extra}.`)
  } else {
    ctx.out.info(`${seeder} is already registered in ${path}.`)
  }
  return {
    seeder,
    path,
    status: result.status,
    created: result.created,
    migrated: result.migrated,
    missingParents: result.missingAfter,
  }
}

/** The interactive field builder: one spec per prompt, validated as you type. */
async function promptFields(ctx: CommandContext): Promise<string[]> {
  const specs: string[] = []
  for (;;) {
    const spec = await ctx.prompt.text(
      'Add a field (name:type[:modifier…]), or press Enter to finish',
      {
        default: '',
        placeholder: 'title:string[200]:required',
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

// --- Migration-first (v2) apps ------------------------------------------------------------------
// make:model, make:factory and make:seeder write the shapes the skeleton uses (Model('posts'),
// defineFactory, defineSeeder from @strutvane/framework/database), never v1's defineModel files.

/** Read a project file, `undefined` when it doesn't exist. */
function projectReader(root: string): (path: string) => string | undefined {
  return (path) => {
    const file = join(root, path)
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }
}

/** Write planned v2 files (never overwriting owned ones) and report kept files and manual steps. */
async function writeV2Files(
  ctx: CommandContext,
  files: readonly GeneratedFile[],
  extra: readonly GeneratedFile[],
  plan: { readonly kept: readonly string[]; readonly manual: readonly string[] },
): Promise<Awaited<ReturnType<typeof applyGenerator>>> {
  const data = await applyGenerator(
    ctx,
    migrationFirstGenerator,
    { files: files.map((file) => ({ path: file.path, content: file.content })) },
    'node strut migrate',
    extra,
  )
  for (const path of plan.kept) ctx.out.info(`Kept ${path} (it already exists).`)
  if (plan.manual.length > 0) {
    ctx.out.warn(
      `${DATABASE_SEEDER_FILE} has no ${SEEDERS_START} ... ${SEEDERS_END} markers, so the seeder was not registered. Add:`,
    )
    for (const line of plan.manual) ctx.out.warn(`  ${line}`)
  }
  return data
}

/** The v2 model file must exist for make:factory / make:seeder --model. */
function requireV2Model(root: string, n: Names): void {
  const path = `app/models/${n.kebab}.ts`
  if (!existsSync(join(root, path)))
    throw new CliError('model_not_found', {
      exitCode: EXIT.VALIDATION,
      params: { model: n.pascal, path },
    })
}

/** Add the seeder to database.seeder.ts (or say how), like make:migration --seeder. */
function planV2Registration(
  read: (path: string) => string | undefined,
  seeder: string,
  file: string,
): { readonly extra: GeneratedFile[]; readonly manual: readonly string[] } {
  const result = registerSeederV2(
    read(DATABASE_SEEDER_FILE) ?? databaseSeederStub(),
    seeder,
    `./${file}.seeder.ts`,
  )
  if (result.status === 'registered')
    return {
      extra: [{ path: DATABASE_SEEDER_FILE, content: result.content, overwrite: true }],
      manual: [],
    }
  return { extra: [], manual: result.status === 'unrecognised' ? result.manual : [] }
}

/**
 * Tenant scoping for a new model. In an app with multi-tenancy (`config/tenancy.ts`), models are
 * tenant-scoped unless `--no-tenant` says otherwise: forgetting the flag must never produce a
 * table that every tenant can read (fail closed). Elsewhere the model's own default applies.
 */
export function tenantOption(flag: boolean | undefined, root: string): { tenant?: boolean } {
  if (flag !== undefined) return { tenant: flag }
  return existsSync(join(root, 'config', 'tenancy.ts')) ? { tenant: true } : {}
}

export const makeModelCommand: AnyCommand = defineCommand({
  name: 'make:model',
  description: 'Create a model with its policy, factory, seeder and feature test',
  details: fieldSyntaxDetails(process.platform),
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
      description:
        'Scope rows to the tenant (default in apps with config/tenancy.ts; --no-tenant for global data)',
    },
    audit: { type: 'boolean', default: false, description: 'Record changes in the audit log' },
    'soft-deletes': { type: 'boolean', default: false, description: 'Delete by setting deletedAt' },
    timestamps: { type: 'boolean', default: true, description: 'Add createdAt/updatedAt' },
    migration: {
      type: 'boolean',
      default: true,
      description:
        'Migration-first apps: also create create_<table>_table (--no-migration to skip)',
    },
    seed: {
      type: 'string',
      valueName: '<n>',
      default: '10',
      description: 'Rows the seeder creates',
    },
  },
  examples: makeModelExamples(process.platform),
  async run(ctx) {
    const n = modelNames(ctx.args.name)
    const projectRoot = ctx.requireProject().root
    if (isMigrationFirstProject(projectRoot)) {
      if (ctx.args.fields.length > 0)
        throw usageError('invalid_argument', {
          detail: `In migration-first apps the columns live in the migration, not the model. Run node strut make:model ${n.pascal} (it creates the create_${n.snakePlural}_table migration), then add the columns there (t.string('title'), ...).`,
          command: ctx.command,
        })
      const count = Number(ctx.flags.seed)
      if (!Number.isInteger(count) || count < 1 || count > 100_000)
        throw usageError('invalid_flag_value', {
          detail: '--seed must be a whole number from 1 to 100000.',
          command: ctx.command,
        })
      const table = n.snakePlural
      const read = projectReader(projectRoot)
      const plan = migrationFirstFiles(
        projectRoot,
        `create_${table}_table`,
        new Date(ctx.services.clock.now()),
        { seeder: ctx.flags.seeder, factory: ctx.flags.factory, read },
      )
      const seederPath = `database/seeders/${n.kebab}.seeder.ts`
      const files = plan.files
        .filter((file) => file.overwrite !== true)
        .filter((file) => ctx.flags.migration || !file.path.startsWith('database/migrations/'))
        .map((file) =>
          file.path === seederPath ? { ...file, content: seederStub(table, count) } : file,
        )
      const kept = [...plan.kept]
      const policyPath = `app/policies/${n.kebab}.policy.ts`
      if (ctx.flags.policy) {
        if (existsSync(join(projectRoot, policyPath))) kept.push(policyPath)
        else files.push({ path: policyPath, content: policyStub(table) })
      }
      const data = await writeV2Files(
        ctx,
        files,
        plan.files.filter((file) => file.overwrite === true),
        { kept, manual: plan.manual },
      )
      return { data: { model: n.pascal, table, ...data } }
    }
    const specs =
      ctx.args.fields.length === 0 && ctx.prompt.interactive
        ? await promptFields(ctx)
        : ctx.args.fields
    const fields = parseFields(specs)
    const seedCount = Number(ctx.flags.seed)
    if (!Number.isInteger(seedCount) || seedCount < 1 || seedCount > 100_000) {
      throw usageError('invalid_flag_value', {
        detail: '--seed must be a whole number from 1 to 100000.',
        command: ctx.command,
      })
    }
    const root = ctx.requireProject().root
    const parents = fields.flatMap((f) =>
      f.type === 'belongsTo' && f.typeArgs[0] !== undefined ? [f.typeArgs[0]] : [],
    )
    const seeding = ctx.flags.seeder
      ? planSeederRegistration(root, n, n.pascal, parents)
      : undefined
    const data = await applyGenerator(
      ctx,
      modelGenerator,
      {
        name: n.pascal,
        fields,
        options: {
          timestamps: ctx.flags.timestamps,
          softDeletes: ctx.flags['soft-deletes'],
          ...tenantOption(ctx.flags.tenant, ctx.requireProject().root),
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
      'node strut migrate',
      seeding?.file === undefined ? [] : [seeding.file],
    )
    const seederRegistration =
      seeding === undefined ? null : reportSeederRegistration(ctx, seeding, data.dryRun)
    return { data: { model: n.pascal, fields, ...data, seederRegistration } }
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
  examples: ['node strut make:resource Invoice --actions approve,send --hooks beforeCreate'],
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
  examples: ['node strut make:policy Invoice --template owner'],
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
  examples: ['node strut make:factory Invoice'],
  async run(ctx) {
    const n = modelNames(ctx.args.model)
    const projectRoot = ctx.requireProject().root
    if (isMigrationFirstProject(projectRoot)) {
      requireV2Model(projectRoot, n)
      const data = await writeV2Files(
        ctx,
        [{ path: `database/factories/${n.kebab}.factory.ts`, content: factoryStub(n.snakePlural) }],
        [],
        { kept: [], manual: [] },
      )
      return { data }
    }
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
  examples: ['node strut make:seeder Invoice --model Invoice --count 50'],
  async run(ctx) {
    const n = names(ctx.args.name, 'Seeder name')
    const model = ctx.flags.model === undefined ? undefined : modelNames(ctx.flags.model)
    const count = Number(ctx.flags.count)
    if (!Number.isInteger(count) || count < 1 || count > 100_000) {
      throw usageError('invalid_flag_value', {
        detail: '--count must be a whole number from 1 to 100000.',
        command: ctx.command,
      })
    }
    const projectRoot = ctx.requireProject().root
    if (isMigrationFirstProject(projectRoot)) {
      // `make:seeder InvoiceSeeder` and `make:seeder Invoice` both mean invoice.seeder.ts.
      const s = names(ctx.args.name.replace(/[-_ ]?seeder$/i, '') || ctx.args.name, 'Seeder name')
      const read = projectReader(projectRoot)
      const files: GeneratedFile[] = []
      const kept: string[] = []
      let extra: GeneratedFile[] = []
      let manual: readonly string[] = []
      if (model === undefined) {
        files.push({
          path: `database/seeders/${s.kebab}.seeder.ts`,
          content: blankSeederStub(s.pascal),
        })
      } else {
        requireV2Model(projectRoot, model)
        const factoryPath = `database/factories/${model.kebab}.factory.ts`
        if (existsSync(join(projectRoot, factoryPath))) kept.push(factoryPath)
        else files.push({ path: factoryPath, content: factoryStub(model.snakePlural) })
        files.push({
          path: `database/seeders/${s.kebab}.seeder.ts`,
          content: seederStub(model.snakePlural, count),
        })
        ;({ extra, manual } = planV2Registration(read, `${s.pascal}Seeder`, s.kebab))
      }
      const data = await writeV2Files(ctx, files, extra, { kept, manual })
      return { data }
    }
    // A seeder tied to a model is registered in database.seeder.ts like make:model's.
    const seeding =
      model === undefined
        ? undefined
        : planSeederRegistration(ctx.requireProject().root, n, model.pascal)
    const data = await applyGenerator(
      ctx,
      seederGenerator,
      { name: n.pascal, model: model?.pascal, count },
      undefined,
      seeding?.file === undefined ? [] : [seeding.file],
    )
    const seederRegistration =
      seeding === undefined ? null : reportSeederRegistration(ctx, seeding, data.dryRun)
    return { data: { ...data, seederRegistration } }
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
  examples: ['node strut make:test invoice-totals --unit --model Invoice'],
  async run(ctx) {
    if (ctx.flags.unit === true && ctx.flags.e2e === true) {
      throw usageError('invalid_argument', { detail: 'Choose one of --unit and --e2e.' })
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
  description: 'Create a migration (and, for create_*_table, its model)',
  details:
    'Migration-first apps: create_posts_table creates a table and app/models/post.ts; add_x_to_posts_table alters one; any other name gets a blank migration. --seeder adds the seeder and its factory and registers the seeder in database/seeders/database.seeder.ts; --factory adds only the factory. v1 apps (strutvane.config.ts, no Laravel-named migrations) get a hand-written stub.',
  args: {
    name: {
      required: true,
      description: 'snake_case, e.g. create_posts_table or add_subtitle_to_posts_table',
    },
  },
  flags: {
    seeder: {
      type: 'boolean',
      description: 'Also create the seeder and its factory, and register the seeder',
    },
    factory: { type: 'boolean', description: 'Also create the factory' },
    sql: { type: 'boolean', description: 'v1 apps: a raw .sql file instead of TypeScript' },
    table: {
      type: 'string',
      valueName: '<table>',
      description: 'v1 apps: pre-fill an ALTER TABLE statement for this table',
    },
  },
  examples: [
    'node strut make:migration create_posts_table --seeder',
    'node strut make:migration add_subtitle_to_posts_table',
  ],
  async run(ctx) {
    const name = names(ctx.args.name, 'Migration name').snake
    const root = ctx.requireProject().root
    if (ctx.flags.sql === true || !isMigrationFirstProject(root)) {
      const data = await applyGenerator(
        ctx,
        migrationGenerator,
        {
          name,
          timestamp: migrationTimestamp(ctx.services.clock.now()),
          sql: ctx.flags.sql === true,
          table: ctx.flags.table,
        },
        'node strut migrate',
      )
      return { data }
    }
    const plan = migrationFirstFiles(root, name, new Date(ctx.services.clock.now()), {
      seeder: ctx.flags.seeder === true,
      factory: ctx.flags.factory === true,
      read: (path) => {
        const file = join(root, path)
        return existsSync(file) ? readFileSync(file, 'utf8') : undefined
      },
    })
    if ((ctx.flags.seeder === true || ctx.flags.factory === true) && plan.table === undefined) {
      throw usageError('invalid_argument', {
        detail: `Can't tell which table "${name}" is about, so no seeder or factory was written. Name it create_<table>_table or add_<column>_to_<table>_table.`,
      })
    }
    const own = plan.files.filter((file) => file.overwrite !== true)
    const extra = plan.files.filter((file) => file.overwrite === true)
    const data = await applyGenerator(
      ctx,
      migrationFirstGenerator,
      { files: own.map((file) => ({ path: file.path, content: file.content })) },
      'node strut migrate',
      extra,
    )
    for (const path of plan.kept) ctx.out.info(`Kept ${path} (it already exists).`)
    if (plan.manual.length > 0) {
      ctx.out.warn(
        `${DATABASE_SEEDER_FILE} has no ${SEEDERS_START} … ${SEEDERS_END} markers, so the seeder was not registered. Add:`,
      )
      for (const line of plan.manual) ctx.out.warn(`  ${line}`)
    }
    return { data }
  },
})
