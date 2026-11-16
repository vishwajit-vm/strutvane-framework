/**
 * Naming conventions, Laravel-style: `posts` table ⇄ `Post` model ⇄ "Posts" label, and
 * `create_posts_table` migration name ⇄ `schema.create('posts', …)`.
 *
 * The inflector is deliberately small: regular English rules plus a short irregular list. When it
 * guesses wrong, the developer overrides the label in the resource config. That is cheaper and more
 * predictable than shipping a big inflection library whose rules nobody can remember.
 *
 * @module
 */

const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
  ['person', 'people'],
  ['child', 'children'],
  ['man', 'men'],
  ['woman', 'women'],
  ['mouse', 'mice'],
  ['datum', 'data'],
])

const IRREGULAR_SINGULARS: ReadonlyMap<string, string> = new Map(
  [...IRREGULAR_PLURALS].map(([singular, plural]) => [plural, singular]),
)

/** Words that are the same in singular and plural, so we must leave them alone. */
const UNCOUNTABLE: ReadonlySet<string> = new Set([
  'equipment',
  'information',
  'media',
  'news',
  'series',
  'species',
])

/**
 * Turn a singular English word into its plural.
 *
 * Only the last `_`-separated part is inflected, so `blog_post` becomes `blog_posts`, the same as
 * Laravel's `Str::plural`.
 *
 * @example
 * pluralize('category') // 'categories'
 * pluralize('blog_post') // 'blog_posts'
 */
export function pluralize(word: string): string {
  return inflectLastPart(word, pluralizeOne)
}

/**
 * Turn a plural English word into its singular.
 *
 * @example
 * singularize('categories') // 'category'
 * singularize('statuses') // 'status'
 */
export function singularize(word: string): string {
  return inflectLastPart(word, singularizeOne)
}

function inflectLastPart(word: string, inflect: (part: string) => string): string {
  const parts = word.split('_')
  const last = parts.pop() ?? ''
  return [...parts, inflect(last)].join('_')
}

function pluralizeOne(word: string): string {
  if (UNCOUNTABLE.has(word)) return word
  const irregular = IRREGULAR_PLURALS.get(word)
  if (irregular !== undefined) return irregular
  // "category" → "categories", but "day" → "days" (a vowel before the y keeps it).
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  // "status" → "statuses", "box" → "boxes", "match" → "matches".
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}

function singularizeOne(word: string): string {
  if (UNCOUNTABLE.has(word)) return word
  const irregular = IRREGULAR_SINGULARS.get(word)
  if (irregular !== undefined) return irregular
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  // "status" and "bus" are already singular; only strip a plain trailing "s".
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1)
  return word
}

/**
 * `snake_case` → `PascalCase`, used for model and type names.
 *
 * @example
 * pascalCase('blog_post') // 'BlogPost'
 */
export function pascalCase(snake: string): string {
  return snake
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * `snake_case` → `camelCase`, used for relation names.
 *
 * @example
 * camelCase('blog_posts') // 'blogPosts'
 */
export function camelCase(snake: string): string {
  const pascal = pascalCase(snake)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/**
 * A human label for a column or table name, the way a UI would show it.
 *
 * Foreign key columns drop their `_id`, because a person thinks "Author", not "Author id".
 *
 * @example
 * humanize('author_id') // 'Author'
 * humanize('created_at') // 'Created at'
 */
export function humanize(snake: string): string {
  const withoutId = snake.endsWith('_id') ? snake.slice(0, -3) : snake
  const words = withoutId.split('_').filter((part) => part.length > 0)
  const sentence = words.join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/**
 * The model name for a table: singular and PascalCase, exactly like Laravel.
 *
 * @example
 * modelNameForTable('blog_posts') // 'BlogPost'
 */
export function modelNameForTable(table: string): string {
  return pascalCase(singularize(table))
}

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
 * Turn any text into a URL slug: lower case, ASCII letters and digits, single dashes.
 * Accents are folded ("Crème brûlée" → "creme-brulee") so slugs stay readable in any URL.
 *
 * @example
 * slugify('Hello, World!') // 'hello-world'
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // drop the accents NFKD split off
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
