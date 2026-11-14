/**
 * Locale handling: canonicalising tags, fallback chains and `Accept-Language` negotiation.
 *
 * @module
 */

/** Canonical form of a BCP 47 tag (`en-us` → `en-US`), or `undefined` if it isn't valid. */
export function canonicalLocale(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0]
  } catch {
    return undefined
  }
}

/** The language part of a tag: `pt-BR` → `pt`. */
export function baseLanguage(tag: string): string {
  return tag.split('-')[0]?.toLowerCase() ?? tag
}

/** Locales to try, most specific first: `pt-BR` → `["pt-BR", "pt", "en"]` (deduplicated). */
export function localeChain(locale: string, fallback = 'en'): readonly string[] {
  const canonical = canonicalLocale(locale) ?? fallback
  return [...new Set([canonical, baseLanguage(canonical), fallback])]
}

const MAX_HEADER_LENGTH = 4096
const MAX_ENTRIES = 50

/**
 * Pick the best supported locale for an `Accept-Language` header.
 *
 * Exact matches win, then a match on the base language (`fr-CH` → `fr`), in the client's
 * q-value order. `q=0` means "not acceptable". Oversized or malformed headers fall back safely,
 * since the header is attacker-controlled input.
 */
export function negotiateLocale(
  header: string | undefined,
  supported: readonly string[],
  fallback = 'en',
): string {
  if (!header || supported.length === 0) return fallback
  const canonicalSupported = supported.map((s) => ({
    original: s,
    canonical: canonicalLocale(s) ?? s,
  }))
  const entries = header
    .slice(0, MAX_HEADER_LENGTH)
    .split(',')
    .slice(0, MAX_ENTRIES)
    .map((part, index) => {
      const [rawTag = '', ...paramsParts] = part.trim().split(';')
      const q = paramsParts
        .map((p) => /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/.exec(p)?.[1])
        .find((v) => v !== undefined)
      return { tag: rawTag.trim(), q: q === undefined ? 1 : Number(q), index }
    })
    .filter((e) => e.tag !== '' && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)

  for (const { tag } of entries) {
    if (tag === '*') return fallback
    const canonical = canonicalLocale(tag)
    if (!canonical) continue
    const exact = canonicalSupported.find(
      (s) => s.canonical.toLowerCase() === canonical.toLowerCase(),
    )
    if (exact) return exact.original
    const base = baseLanguage(canonical)
    const byBase = canonicalSupported.find((s) => baseLanguage(s.canonical) === base)
    if (byBase) return byBase.original
  }
  return fallback
}
