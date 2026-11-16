/**
 * Small string helpers shared by routing, generators and friendly error messages.
 *
 * `singular()` is deliberately simple: the type-level `Singular<>` in `routing/types.ts` mirrors
 * it rule for rule, so `Route.resource('posts')` names its parameter `{post}` both at runtime and
 * in the types. A full inflector could not be mirrored in types; irregular words use the
 * resource's `parameter` option instead.
 *
 * @module
 */

/**
 * The singular of a plural resource name (three rules: `-ies`, `-sses`, `-s`).
 *
 * @example
 * singular('categories') // 'category'
 * singular('posts') // 'post'
 */
export function singular(word: string): string {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('sses')) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/**
 * A simple plural, for generated names (`Post` → `posts`).
 *
 * @example
 * plural('category') // 'categories'
 */
export function plural(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}

/**
 * `PostPolicy` / `post-policy` → `post_policy`.
 *
 * @example
 * snakeCase('BlogPost') // 'blog_post'
 */
export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/**
 * `blog_post` → `BlogPost`.
 *
 * @example
 * pascalCase('send-reports') // 'SendReports'
 */
export function pascalCase(text: string): string {
  return text
    .split(/[_\-\s:]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

/**
 * `BlogPost` → `blog-post` (file names).
 *
 * @example
 * kebabCase('BlogPost') // 'blog-post'
 */
export function kebabCase(name: string): string {
  return snakeCase(name).replace(/_/g, '-')
}

/**
 * Levenshtein distance (two-row dynamic programming: O(a·b) time, O(b) memory).
 *
 * @example
 * editDistance('auht', 'auth') // 2
 */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      const insertion = (current[j - 1] ?? 0) + 1
      const deletion = (previous[j] ?? 0) + 1
      current.push(Math.min(substitution, insertion, deletion))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/**
 * The candidate closest to `input`, for "did you mean …?" hints, or `undefined` when nothing is
 * close (roughly one typo per four characters, and always at least two, are allowed).
 *
 * @example
 * closestMatch('auht', ['auth', 'csrf']) // 'auth'
 */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const budget = Math.max(2, Math.floor(input.length / 4))
  let best: { name: string; distance: number } | undefined
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate)
    if (distance <= budget && (best === undefined || distance < best.distance))
      best = { name: candidate, distance }
  }
  return best?.name
}
