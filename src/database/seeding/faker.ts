/**
 * A small, dependency-free fake-data generator for factories (`({ faker }) => ({ … })`).
 *
 * Why not a big faker library: factories need plausible, valid values for the column types the
 * migrations allow, deterministically (a seed reproduces a failing test), with nothing to install.
 * Every value is plain ASCII and fits the usual column limits, so it passes the ORM's casts on
 * every engine.
 *
 * @module
 */
import { uuidv7 } from '../orm/keys.ts'

const WORDS = [
  'alpha',
  'amber',
  'anchor',
  'apple',
  'arch',
  'atlas',
  'aurora',
  'basil',
  'beacon',
  'birch',
  'bloom',
  'breeze',
  'bridge',
  'canyon',
  'cedar',
  'cinder',
  'cloud',
  'comet',
  'coral',
  'crest',
  'dawn',
  'delta',
  'dune',
  'echo',
  'ember',
  'falcon',
  'fern',
  'field',
  'flint',
  'forge',
  'garden',
  'glade',
  'granite',
  'harbor',
  'hazel',
  'horizon',
  'island',
  'ivory',
  'jade',
  'juniper',
  'lagoon',
  'lantern',
  'maple',
  'meadow',
  'mesa',
  'mist',
  'moss',
  'north',
  'oak',
  'ocean',
  'orbit',
  'pebble',
  'pine',
  'prairie',
  'quartz',
  'raven',
  'reef',
  'ridge',
  'river',
  'sage',
  'shore',
  'sierra',
  'slate',
  'spruce',
  'summit',
  'thistle',
  'tide',
  'timber',
  'valley',
  'willow',
] as const
const FIRST = [
  'Ada',
  'Alan',
  'Ana',
  'Ben',
  'Chen',
  'Dara',
  'Eli',
  'Fatima',
  'Grace',
  'Hiro',
  'Ines',
  'Jon',
  'Kai',
  'Lena',
  'Mira',
  'Noah',
  'Omar',
  'Priya',
  'Rosa',
  'Sam',
  'Tara',
  'Yusuf',
  'Zoe',
] as const
const LAST = [
  'Adams',
  'Baker',
  'Costa',
  'Diaz',
  'Evans',
  'Fischer',
  'Garcia',
  'Hughes',
  'Ito',
  'Jensen',
  'Khan',
  'Lopez',
  'Moreau',
  'Novak',
  'Okafor',
  'Patel',
  'Rossi',
  'Silva',
  'Tanaka',
  'Wang',
] as const

/**
 * The generator a factory definition receives.
 *
 * @example
 * defineFactory(Post, ({ faker }) => ({ title: faker.sentence(), views: faker.number({ max: 500 }) }))
 */
export interface Faker {
  /** A whole number in `[min, max]` (defaults 0 and 1000). */
  number(options?: { readonly min?: number; readonly max?: number }): number
  /** A decimal string with `scale` digits after the point, in `[min, max]`. */
  decimal(options?: {
    readonly min?: number
    readonly max?: number
    readonly scale?: number
  }): string
  boolean(): boolean
  /** One of the given values. */
  pick<T>(values: readonly [T, ...T[]]): T
  word(): string
  /** `count` words separated by spaces. */
  words(count?: number): string
  /** A capitalised sentence of 4–10 words, ending with a full stop. */
  sentence(): string
  /** 2–5 sentences. */
  paragraph(): string
  firstName(): string
  lastName(): string
  /** A first and last name. */
  name(): string
  /** A unique-looking address on the reserved `example.com` domain (never a real mailbox). */
  email(): string
  /** A UUIDv7. */
  uuid(): string
  /** A calendar date (`YYYY-MM-DD`) within the last `days` days (default 365). */
  date(options?: { readonly days?: number }): string
  /** A timestamp within the last `days` days (default 365). */
  pastDate(options?: { readonly days?: number }): Date
}

/**
 * A faker driven by a seeded pseudo-random generator (mulberry32): the same seed gives the same
 * values. Without a seed it starts from a random one.
 *
 * @example
 * const faker = createFaker(42)
 * faker.word() === createFaker(42).word() // true
 */
export function createFaker(seed: number = Math.floor(Math.random() * 2 ** 32)): Faker {
  let state = seed >>> 0
  let serial = 0
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1))
  const pick = <T>(values: readonly T[]): T => values[int(0, values.length - 1)] as T
  const word = (): string => pick(WORDS)
  const sentence = (): string => {
    const text = Array.from({ length: int(4, 10) }, word).join(' ')
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
  }
  const now = Date.now()
  const past = (days: number): Date => new Date(now - int(0, days * 86_400) * 1000)
  return {
    number: (options = {}) => int(options.min ?? 0, options.max ?? 1000),
    decimal(options = {}) {
      const scale = options.scale ?? 2
      const factor = 10 ** scale
      const units = int(
        Math.ceil((options.min ?? 0) * factor),
        Math.floor((options.max ?? 1000) * factor),
      )
      return (units / factor).toFixed(scale)
    },
    boolean: () => random() < 0.5,
    pick: (values) => pick(values),
    word,
    words: (count = 3) => Array.from({ length: count }, word).join(' '),
    sentence,
    paragraph: () => Array.from({ length: int(2, 5) }, sentence).join(' '),
    firstName: () => pick(FIRST),
    lastName: () => pick(LAST),
    name: () => `${pick(FIRST)} ${pick(LAST)}`,
    email() {
      serial += 1
      return `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${serial}.${int(100, 999)}@example.com`
    },
    uuid: () => uuidv7(),
    date: (options = {}) =>
      past(options.days ?? 365)
        .toISOString()
        .slice(0, 10),
    pastDate: (options = {}) => past(options.days ?? 365),
  }
}
