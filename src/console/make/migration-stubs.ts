/**
 * `make:migration` naming and stubs, Laravel-style (blueprint §2.3): `create_posts_table`
 * creates a table (and always writes the model), `add_x_to_posts_table` alters one, anything else
 * gets a blank migration.
 *
 * @module
 */
import { modelNameForTable } from '../../core/inflection.ts'

/**
 * What a migration name tells us, Laravel-style. `make:migration` uses it to pick a stub:
 * `create_*_table` gets `schema.create`, anything mentioning `_to_*_table` / `_from_*_table` /
 * `_in_*_table` gets `schema.table`, and everything else gets an empty migration.
 *
 * @example
 * const intent: MigrationIntent = { kind: 'create', table: 'posts' }
 */
export type MigrationIntent =
  | { readonly kind: 'create'; readonly table: string }
  | { readonly kind: 'alter'; readonly table: string }
  | { readonly kind: 'blank' }

/**
 * Read the intent from a migration name such as `create_posts_table` or
 * `add_subtitle_to_posts_table`. The timestamp prefix and `.ts` suffix are optional.
 *
 * @example
 * inferMigrationIntent('create_posts_table') // { kind: 'create', table: 'posts' }
 * inferMigrationIntent('2026_01_03_000000_add_subtitle_to_posts_table.ts') // { kind: 'alter', table: 'posts' }
 */
export function inferMigrationIntent(name: string): MigrationIntent {
  const bare = name.replace(/\.ts$/, '').replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, '')
  const created = /^create_([a-z0-9_]+?)_table$/.exec(bare)
  if (created?.[1] !== undefined) return { kind: 'create', table: created[1] }
  const altered = /_(?:to|from|in|on)_([a-z0-9_]+?)_table$/.exec(bare)
  if (altered?.[1] !== undefined) return { kind: 'alter', table: altered[1] }
  return { kind: 'blank' }
}

/**
 * The file name `make:migration` writes: a sortable timestamp prefix plus the snake-case name.
 * The timestamp is passed in (not read from the clock) so callers and tests stay deterministic.
 *
 * @example
 * migrationFileName('create_posts_table', new Date('2026-01-02T00:00:00Z')) // '2026_01_02_000000_create_posts_table.ts'
 */
export function migrationFileName(name: string, at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${at.getUTCFullYear()}_${pad(at.getUTCMonth() + 1)}_${pad(at.getUTCDate())}`
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  return `${date}_${time}_${name}.ts`
}

/**
 * The starting content of a new migration file, chosen from its name. This is the Strutvane
 * version of Laravel's `create.stub` / `update.stub` / `blank.stub`. The file imports
 * `migration` from `@strutvane/framework/schema`, the only package import the replay sandbox
 * allows in a migration.
 *
 * @example
 * migrationStub('create_posts_table') // "…schema.create('posts', (t) => {\n      t.id()…"
 */
export function migrationStub(name: string): string {
  const intent = inferMigrationIntent(name)
  const header =
    "import { migration } from '@strutvane/framework/schema'\n\nexport default migration({\n"
  if (intent.kind === 'create') {
    return `${header}  up(schema) {
    schema.create('${intent.table}', (t) => {
      t.id()
      t.timestamps()
    })
  },
  down(schema) {
    schema.dropIfExists('${intent.table}')
  },
})
`
  }
  if (intent.kind === 'alter') {
    return `${header}  up(schema) {
    schema.table('${intent.table}', (t) => {
      // Add, rename or drop columns here.
    })
  },
  down(schema) {
    schema.table('${intent.table}', (t) => {
      // Undo exactly what up() did, in reverse order.
    })
  },
})
`
  }
  return `${header}  up(schema) {},
  down(schema) {},
})
`
}

/**
 * The model file `make:migration create_posts_table` writes next to the migration
 * (`app/models/post.ts`, decision #59). Columns come from the generated types, so the model only
 * lists what clients may mass-assign; it starts empty, which is the safe default (F-10).
 *
 * @example
 * modelStub('posts') // "…export class Post extends Model('posts', { fillable: [] }) {}…"
 */
export function modelStub(table: string): string {
  const model = modelNameForTable(table)
  return `import { Model } from '@strutvane/framework/database'

/**
 * The \`${table}\` table. Its columns come from the migrations (\`node strut migrate\` regenerates
 * the types), so they are never repeated here. Add relations, scopes and accessors in the class.
 */
export class ${model} extends Model('${table}', {
  // The columns a request may set with ${model}.create(…) / fill(…). Nothing until you list them.
  fillable: [],
}) {}
`
}
