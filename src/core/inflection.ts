/**
 * Inflection, Laravel-style: `posts` table ⇄ `Post` model ⇄ "Posts" label, and slugs.
 *
 * Shared by the schema generators and the CLI's `make:*` commands (pure functions, no imports).
 * The inflector is deliberately small: regular English rules plus a short irregular list. When it
 * guesses wrong, the developer overrides the label in the resource config.
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
