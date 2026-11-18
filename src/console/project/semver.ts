/**
 * A deliberately small semver subset for `strutvane.compat` ranges (docs/09 §11).
 *
 * Supported: exact versions, `*`/`x`, comparators (`>=1.2.0 <2.0.0`), caret (`^1.2.0`, `^0.1.0`),
 * tilde (`~1.2.0`), and `||` alternatives. Prereleases follow npm's rule: a prerelease version only
 * satisfies a comparator that names a prerelease of the same `major.minor.patch`, so
 * `0.1.0-next.3` satisfies `^0.1.0-next.0` but a stable range never pulls in a prerelease by
 * accident.
 *
 * Unparseable ranges are reported as invalid (never as "compatible"), so a typo fails closed.
 *
 * @module
 */

/** A parsed version. */
export interface SemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (string | number)[]
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a version, or `undefined` if it is not valid semver. */
export function parseVersion(text: string): SemVer | undefined {
  const m = VERSION.exec(text.trim())
  if (m === null) return undefined
  const prerelease =
    m[4] === undefined ? [] : m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease }
}

/** Compare two versions: negative, zero or positive. */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length // a release sorts after its prereleases
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

type Operator = '>' | '>=' | '<' | '<=' | '='
interface Comparator {
  readonly op: Operator
  readonly version: SemVer
}

const ZERO: SemVer = { major: 0, minor: 0, patch: 0, prerelease: [] }

/** Expand one space-separated part (`^1.2.0`, `>=1.0.0`, `1.2.3`, `*`) into comparators. */
function expand(part: string): Comparator[] | undefined {
  if (part === '*' || part === 'x' || part === '') return [{ op: '>=', version: ZERO }]
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(part)
  if (m === null || m[2] === undefined) return undefined
  const version = parseVersion(m[2])
  if (version === undefined) return undefined
  const op = m[1] ?? '='
  const { major, minor, patch } = version
  const upper = (v: Omit<SemVer, 'prerelease'>): Comparator => ({
    op: '<',
    version: { ...v, prerelease: [0] }, // excludes prereleases of the next boundary too
  })
  switch (op) {
    case '^': {
      const ceiling =
        major > 0
          ? { major: major + 1, minor: 0, patch: 0 }
          : minor > 0
            ? { major: 0, minor: minor + 1, patch: 0 }
            : { major: 0, minor: 0, patch: patch + 1 }
      return [{ op: '>=', version }, upper(ceiling)]
    }
    case '~':
      return [{ op: '>=', version }, upper({ major, minor: minor + 1, patch: 0 })]
    default:
      return [{ op: op as Operator, version }]
  }
}

/** Parse a range into alternatives of comparator sets, or `undefined` if invalid. */
export function parseRange(range: string): Comparator[][] | undefined {
  const alternatives: Comparator[][] = []
  for (const alternative of range.split('||')) {
    const parts = alternative.trim().split(/\s+/)
    const set: Comparator[] = []
    for (const part of parts) {
      const comparators = expand(part)
      if (comparators === undefined) return undefined
      set.push(...comparators)
    }
    alternatives.push(set)
  }
  return alternatives
}

function test(c: Comparator, v: SemVer): boolean {
  const cmp = compareVersions(v, c.version)
  switch (c.op) {
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    default:
      return cmp === 0
  }
}

/** Options for {@link satisfies}. */
export interface SatisfiesOptions {
  /**
   * Let prerelease versions match by ordering alone (npm's `includePrerelease`). Used for
   * `strutvane.compat`: while the CLI itself is a prerelease (`0.1.0-next.3`), a plugin that
   * declares `*` or `>=0.1.0-0` must still load.
   */
  readonly includePrerelease?: boolean
}

/** Does `version` satisfy `range`? Invalid input returns `false` (fail closed). */
export function satisfies(version: string, range: string, options: SatisfiesOptions = {}): boolean {
  const v = parseVersion(version)
  const alternatives = parseRange(range)
  if (v === undefined || alternatives === undefined) return false
  return alternatives.some((set) => {
    if (!set.every((c) => test(c, v))) return false
    if (v.prerelease.length === 0 || options.includePrerelease === true) return true
    // npm rule: a prerelease only matches a comparator naming a prerelease of the same tuple.
    return set.some(
      (c) =>
        c.version.prerelease.length > 0 &&
        c.op !== '<' &&
        c.version.major === v.major &&
        c.version.minor === v.minor &&
        c.version.patch === v.patch,
    )
  })
}

/**
 * The `strutvane.compat` range that accepts every version of `version`'s release train: the same
 * minor before 1.0 (`0.2.x`), the same major after, prereleases of the train included. Used to tell
 * plugin authors what to declare, so the advice follows the CLI's version instead of going stale
 * at the next release. `undefined` when `version` is not valid semver.
 *
 * @example
 * compatRangeFor('0.2.0-next.3') // '^0.2.0-next.0'
 * compatRangeFor('1.4.2')        // '^1.0.0'
 */
export function compatRangeFor(version: string): string | undefined {
  const v = parseVersion(version)
  if (v === undefined) return undefined
  const base = v.major === 0 ? `0.${v.minor}.0` : `${v.major}.0.0`
  if (v.prerelease.length === 0) return `^${base}`
  const tag = v.prerelease[0]
  return typeof tag === 'string' ? `^${base}-${tag}.0` : `^${base}-0`
}
