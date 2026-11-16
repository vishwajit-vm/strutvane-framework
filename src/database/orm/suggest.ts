/**
 * "Did you mean …?" for misspelled column and relation names.
 */

/**
 * The candidate closest to `input`, if it is close enough to be a likely typo.
 *
 * @example
 * closest('titel', ['title', 'slug']) // 'title'
 */
export function closest(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  // Two edits (one swapped pair of letters) is always a typo; beyond that, at most a third of the
  // word may differ, or the suggestion would confuse more than help.
  return bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : undefined
}

/** Levenshtein distance with a single rolling row. */
function editDistance(a: string, b: string): number {
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
