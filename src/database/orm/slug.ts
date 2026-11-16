/**
 * Slugs: `t.slug('slug').from('title')` in a migration means "fill this from the title on
 * create, and keep it unique".
 *
 * Uniqueness is scoped like the column's unique index (per tenant on tenant tables). A taken slug
 * gets the lowest free `-2`, `-3`, … (decision #49, 2026-11-15), and the unique index stays the real
 * guarantee: if two requests race for the same slug, the loser's insert fails and is retried with
 * the next number.
 */

/**
 * URL-safe ASCII from any text: accents removed, lowercase, words joined by hyphens.
 *
 * @example
 * slugify('Crème Brûlée: the 10 best!', 200) // 'creme-brulee-the-10-best'
 */
export function slugify(source: string, maxLength: number): string {
  const ascii = source
    .normalize('NFKD')
    // Combining marks are what NFKD splits accents into: "é" → "e" + "´".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Leave room for a "-123" suffix so a long title can still get a unique slug.
  const room = Math.max(1, maxLength - 8)
  const trimmed = ascii.slice(0, room).replace(/-+$/g, '')
  return trimmed === '' ? 'item' : trimmed
}

/**
 * The slug to use given the ones already taken that start with `base`: `base` itself when free,
 * otherwise the lowest free `base-2`, `base-3`, … (Laravel style; decision #49). The lookup that
 * fills `taken` is limited to the tenant, so the number only reflects rows in the tenant.
 *
 * @example
 * nextFreeSlug('hello', ['hello', 'hello-2']) // 'hello-3'
 */
export function nextFreeSlug(base: string, taken: readonly string[]): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let number = 2; ; number += 1) {
    const candidate = `${base}-${number}`
    if (!used.has(candidate)) return candidate
  }
}
