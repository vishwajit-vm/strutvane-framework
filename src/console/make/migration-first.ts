/**
 * `make:migration` for migration-first apps (blueprint §2.3, CONSISTENCY #34, #35, #59, #104):
 *
 * - `create_posts_table` → `database/migrations/<timestamp>_create_posts_table.ts` (Schema builder)
 *   **and** the model `app/models/post.ts` (`Model('posts', { fillable: [] })`), unless it exists;
 * - `add_subtitle_to_posts_table` → an alter migration; anything else → a blank one;
 * - `--seeder` adds `database/seeders/post.seeder.ts` **and** its factory
 *   `database/factories/post.factory.ts`, and registers the seeder in `database.seeder.ts`
 *   between the `// strut:seeders:start` and `// strut:seeders:end` markers (#104);
 * - `--factory` adds only the factory.
 *
 * Existing model, seeder and factory files are never overwritten. In `database.seeder.ts` only
 * the marked `call([...])` list and the matching import are touched; everything outside the
 * markers belongs to the developer. A file without the markers is left alone and the exact lines
 * to add are returned.
 *
 * @module
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { modelNameForTable, pascalCase, singularize } from '../../core/inflection.ts'
import { defineGenerator, type GeneratedFile, type Generator } from '../../devkit/index.ts'
import { inferMigrationIntent, migrationFileName, migrationStub, modelStub } from './migration-stubs.ts'

/** The seeder `node strut db:seed` runs. */
export const DATABASE_SEEDER_FILE = 'database/seeders/database.seeder.ts'
/** Marks the start of the CLI-maintained `call([...])` list. */
export const SEEDERS_START = '// strut:seeders:start'
/** Marks its end. */
export const SEEDERS_END = '// strut:seeders:end'

const V2_MIGRATION = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+\.ts$/

/**
 * Is this project migration-first? (The same rule as the framework's `isMigrationFirst`: a
 * Laravel-named `.ts` migration, a generated `.strutvane/schema.json`, or no v1
 * `strutvane.config.ts`.)
 *
 * @example
 * isMigrationFirstProject('/srv/app') // true
 */
export function isMigrationFirstProject(root: string): boolean {
  const dir = join(root, 'database', 'migrations')
  if (existsSync(dir) && readdirSync(dir).some((file) => V2_MIGRATION.test(file))) return true
  if (existsSync(join(root, '.strutvane', 'schema.json'))) return true
  return !existsSync(join(root, 'strutvane.config.ts'))
}

/** The empty database seeder, with the markers. */
export function databaseSeederStub(): string {
  return `import { defineSeeder } from '@strutvane/framework/database'

/**
 * Seeds the database (\`node strut db:seed\`). \`node strut make:migration … --seeder\` adds each
 * new seeder to the list between the markers, after the seeders of the tables it depends on.
 * Everything outside the markers is yours.
 */
export default defineSeeder({
  async run({ call }) {
    ${SEEDERS_START}
    await call([])
    ${SEEDERS_END}
  },
})
`
}

/** A model's seeder (it uses the model's factory, #35). */
export function seederStub(table: string): string {
  const model = modelNameForTable(table)
  const file = singularize(table).replace(/_/g, '-')
  return `import { defineSeeder } from '@strutvane/framework/database'
import ${model}Factory from '../factories/${file}.factory.ts'

/** Seeds the \`${table}\` table. */
export default defineSeeder({
  async run() {
    await ${model}Factory.count(10).create()
  },
})
`
}

/** A model's factory (#89). */
export function factoryStub(table: string): string {
  const model = modelNameForTable(table)
  const file = singularize(table).replace(/_/g, '-')
  return `import { defineFactory } from '@strutvane/framework/database'
import { ${model} } from '../../app/models/${file}.ts'

/** Fake \`${table}\` rows for seeders and tests. Fill in the columns your migration adds. */
export default defineFactory(${model}, ({ faker, sequence }) => ({
  // title: \`\${faker.sentence()} #\${sequence}\`,
}))
`
}

/** The outcome of {@link registerSeederV2}. */
export type SeederRegistrationV2 =
  | { readonly status: 'registered' | 'unchanged'; readonly content: string }
  | { readonly status: 'unrecognised'; readonly manual: readonly string[] }

/**
 * Add `seeder` (imported from `importPath`) to the marked `call([...])` list of a database
 * seeder, appending it (new tables come after the ones they reference). Idempotent; keeps the
 * file's line endings.
 *
 * @example
 * registerSeederV2(databaseSeederStub(), 'PostSeeder', './post.seeder.ts').status // 'registered'
 */
export function registerSeederV2(
  content: string,
  seeder: string,
  importPath: string,
): SeederRegistrationV2 {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const text = content.replace(/\r\n/g, '\n')
  const importLine = `import ${seeder} from '${importPath}'`
  const start = text.indexOf(SEEDERS_START)
  const end = text.indexOf(SEEDERS_END)
  const block = start >= 0 && end > start ? text.slice(start + SEEDERS_START.length, end) : undefined
  const call = block === undefined ? null : /await call\(\[([^\]]*)\]\)/.exec(block)
  if (block === undefined || call === null || call[1] === undefined)
    return {
      status: 'unrecognised',
      manual: [importLine, `await call([… , ${seeder}])  (inside ${SEEDERS_START} … ${SEEDERS_END})`],
    }
  const names = call[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  const hasImport = new RegExp(`^import ${seeder} from `, 'm').test(text)
  if (names.includes(seeder) && hasImport) return { status: 'unchanged', content }
  const nextBlock = block.replace(call[0], `await call([${[...new Set([...names, seeder])].join(', ')}])`)
  let next = `${text.slice(0, start + SEEDERS_START.length)}${nextBlock}${text.slice(end)}`
  if (!hasImport) {
    const imports = [...next.matchAll(/^import .+$/gm)]
    const last = imports.at(-1)
    next =
      last === undefined
        ? `${importLine}\n${next}`
        : `${next.slice(0, (last.index ?? 0) + last[0].length)}\n${importLine}${next.slice((last.index ?? 0) + last[0].length)}`
  }
  return { status: 'registered', content: next.replace(/\n/g, eol) }
}

/** What {@link migrationFirstFiles} produces. */
export interface MigrationFirstPlan {
  readonly files: readonly GeneratedFile[]
  /** Files that already existed and were kept as they are. */
  readonly kept: readonly string[]
  /** Lines to add by hand when `database.seeder.ts` has no markers. */
  readonly manual: readonly string[]
  readonly table: string | undefined
}

/**
 * The files `make:migration <name>` writes in a migration-first project.
 *
 * @example
 * migrationFirstFiles('/srv/app', 'create_posts_table', new Date(), { seeder: true, factory: false, read })
 */
export function migrationFirstFiles(
  root: string,
  name: string,
  at: Date,
  options: {
    readonly seeder: boolean
    readonly factory: boolean
    readonly read: (path: string) => string | undefined
  },
): MigrationFirstPlan {
  const files: GeneratedFile[] = [
    { path: `database/migrations/${migrationFileName(name, at)}`, content: migrationStub(name) },
  ]
  const kept: string[] = []
  const manual: string[] = []
  const intent = inferMigrationIntent(name)
  const table = intent.kind === 'blank' ? undefined : intent.table
  const addIfMissing = (path: string, content: string): void => {
    if (existsSync(join(root, path))) kept.push(path)
    else files.push({ path, content })
  }
  if (table !== undefined) {
    const file = singularize(table).replace(/_/g, '-')
    if (intent.kind === 'create') addIfMissing(`app/models/${file}.ts`, modelStub(table))
    if (options.seeder || options.factory)
      addIfMissing(`database/factories/${file}.factory.ts`, factoryStub(table))
    if (options.seeder) {
      addIfMissing(`database/seeders/${file}.seeder.ts`, seederStub(table))
      const seeder = `${pascalCase(singularize(table))}Seeder`
      const current = options.read(DATABASE_SEEDER_FILE) ?? databaseSeederStub()
      const result = registerSeederV2(current, seeder, `./${file}.seeder.ts`)
      if (result.status === 'registered')
        files.push({ path: DATABASE_SEEDER_FILE, content: result.content, overwrite: true })
      if (result.status === 'unrecognised') manual.push(...result.manual)
    }
  }
  return { files, kept, manual, table }
}

/** Input of {@link migrationFirstGenerator}: the planned new files. */
export interface MigrationFirstInput {
  readonly files: readonly { readonly path: string; readonly content: string }[]
}

/** Writes the files {@link migrationFirstFiles} planned (never overwriting an existing one). */
export const migrationFirstGenerator: Generator<MigrationFirstInput> = defineGenerator({
  name: 'migration-first',
  inputs: z.object({
    files: z.array(
      z.object({
        path: z.string().regex(/^(?:database|app)\/[a-z0-9_./-]+\.ts$/),
        content: z.string(),
      }),
    ),
  }) as z.ZodType<MigrationFirstInput>,
  files: (input) => input.files,
})
