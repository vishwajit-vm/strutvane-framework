/**
 * `defineFactory()`: the factory files `sv make:factory` / `sv make:model` generate
 * (`database/factories/<name>.factory.ts`), used by tests and seeders.
 *
 * ```ts
 * export default defineFactory(Invoice, ({ fake, related }) => ({
 *   number: fake.words(2),
 *   amount: fake.decimal({ min: 0, max: 10_000, scale: 2 }),
 *   customer: related('Customer'),
 * }))
 *
 * await InvoiceFactory.createMany(t, 3)          // t: a test app or a seeder context
 * const input = InvoiceFactory.attributes({ status: 'paid' })
 * ```
 *
 * Fake data is deterministic per factory call order (a seeded generator, no `Math.random`), so a
 * failing test reproduces exactly. Values never look like real personal data (`example.test`).
 *
 * @module
 */
import type { DataRecord, Repository, Scope } from '../data/repository.ts'
import type { AnyModel, CreateInput, InferModel, ModelDefinition } from '../model/define-model.ts'
import { createFactory } from './factory.ts'

/** Something that hands out repositories: a test app or a seeder context. */
export interface FactoryTarget {
  repository(model: AnyModel | string): Repository
}

/** Deterministic fake values. */
export interface Fake {
  words(count?: number): string
  paragraph(): string
  email(): string
  url(): string
  phone(): string
  slug(): string
  password(): string
  color(): string
  uuid(): string
  ulid(): string
  address(): string
  geoPoint(): { readonly lat: number; readonly lng: number }
  boolean(): boolean
  date(): string
  time(): string
  datetime(): string
  duration(): string
  integer(range?: { readonly min?: number; readonly max?: number }): number
  float(range?: { readonly min?: number; readonly max?: number }): number
  decimal(options?: {
    readonly min?: number
    readonly max?: number
    readonly scale?: number
  }): string
  money(options?: { readonly currency?: string }): {
    readonly amount: string
    readonly currency: string
  }
  pick<T>(values: readonly T[]): T
  subset<T>(values: readonly T[]): T[]
}

/** Marker for a `belongsTo` value created on demand (`related('Customer')`). */
export interface RelatedMarker {
  readonly __related: string
}

/** What a factory definition receives. */
export interface FactoryHelpers {
  readonly fake: Fake
  /** A parent record of `model`, created with default fake values when the record is saved. */
  related(model: string): RelatedMarker
  /** 1, 2, 3, … per factory. */
  readonly sequence: number
}

/** A defined factory. */
export interface DefinedFactory<M extends AnyModel> {
  readonly model: M
  /** Values for one record, without saving (related parents are left out). */
  attributes(overrides?: Partial<CreateInput<M>>): Record<string, unknown>
  /** Save one record. */
  create(
    target: FactoryTarget,
    overrides?: Partial<CreateInput<M>>,
    scope?: Scope,
  ): Promise<InferModel<M>>
  /** Save `count` records. */
  createMany(
    target: FactoryTarget,
    count: number,
    overrides?: Partial<CreateInput<M>>,
    scope?: Scope,
  ): Promise<InferModel<M>[]>
}

const WORDS = [
  'amber',
  'birch',
  'cedar',
  'delta',
  'ember',
  'fjord',
  'grove',
  'harbor',
  'iris',
  'juniper',
  'kestrel',
  'lumen',
  'meadow',
  'nova',
  'orchid',
  'prairie',
  'quartz',
  'river',
  'sierra',
  'tundra',
]

/** A tiny seeded generator (mulberry32): deterministic and dependency-free. */
export function createFake(seed: number): Fake {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min: number, max: number): number => Math.floor(next() * (max - min + 1)) + min
  const hex = (n: number): string =>
    Array.from({ length: n }, () => int(0, 15).toString(16)).join('')
  const word = (): string => WORDS[int(0, WORDS.length - 1)] ?? 'amber'
  const pad = (n: number): string => String(n).padStart(2, '0')
  const fake: Fake = {
    words: (count = 3) => Array.from({ length: count }, word).join(' '),
    paragraph: () => `${fake.words(8)}.`,
    email: () => `${word()}.${int(1, 99_999)}@example.test`,
    url: () => `https://example.test/${word()}/${int(1, 99_999)}`,
    phone: () => `+1555${String(int(0, 9_999_999)).padStart(7, '0')}`,
    slug: () => `${word()}-${word()}-${int(1, 999)}`,
    password: () => `${hex(16)}A!`,
    color: () => `#${hex(6)}`,
    uuid: () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`,
    ulid: () =>
      Array.from({ length: 26 }, () => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[int(0, 31)]).join(''),
    address: () => `${int(1, 999)} ${word()} street`,
    geoPoint: () => ({ lat: int(-90_000, 90_000) / 1000, lng: int(-180_000, 180_000) / 1000 }),
    boolean: () => next() < 0.5,
    date: () => `2026-${pad(int(1, 12))}-${pad(int(1, 28))}`,
    time: () => `${pad(int(0, 23))}:${pad(int(0, 59))}:00`,
    datetime: () => `${fake.date()}T${fake.time()}.000Z`,
    duration: () => `PT${int(1, 90)}M`,
    integer: (r = {}) => int(r.min ?? 0, r.max ?? 1000),
    float: (r = {}) => (r.min ?? 0) + next() * ((r.max ?? 1000) - (r.min ?? 0)),
    decimal: (o = {}) => fake.float(o).toFixed(o.scale ?? 2),
    money: (o = {}) => ({
      amount: fake.decimal({ min: 1, max: 10_000 }),
      currency: o.currency ?? 'USD',
    }),
    pick: <T>(values: readonly T[]): T => {
      if (values.length === 0) throw new RangeError('fake.pick() needs at least one value')
      return values[int(0, values.length - 1)] as T
    },
    subset: <T>(values: readonly T[]): T[] => values.filter(() => next() < 0.5),
  }
  return fake
}

const isRelated = (v: unknown): v is RelatedMarker =>
  typeof v === 'object' && v !== null && '__related' in v

/** Define a factory for a model. */
export function defineFactory<M extends AnyModel>(
  model: M,
  build: (helpers: FactoryHelpers) => Partial<Record<keyof CreateInput<M> & string, unknown>>,
): DefinedFactory<M> {
  const definition: ModelDefinition = model.definition
  let sequence = 0
  const raw = (overrides: Record<string, unknown>): Record<string, unknown> => {
    sequence += 1
    const helpers: FactoryHelpers = {
      fake: createFake(sequence * 7919 + definition.name.length),
      related: (name) => Object.freeze({ __related: name }),
      sequence,
    }
    return { ...build(helpers), ...overrides }
  }
  const create = async (
    target: FactoryTarget,
    overrides: Record<string, unknown> = {},
    scope: Scope = {},
  ): Promise<InferModel<M>> => {
    const input = raw(overrides)
    for (const [key, value] of Object.entries(input)) {
      if (!isRelated(value)) continue
      const parentRepo = target.repository(value.__related)
      const parent = await createFactory(
        parentRepo.model,
        (name) => target.repository(name),
        typeof scope.tenantId === 'string' ? { tenantId: scope.tenantId } : {},
      ).create()
      input[key] = (parent as unknown as DataRecord).id
    }
    return (await target.repository(model).create(input, scope)) as unknown as InferModel<M>
  }
  const factory: DefinedFactory<M> = {
    model,
    attributes: (overrides = {}) =>
      Object.fromEntries(
        Object.entries(raw(overrides as Record<string, unknown>)).filter(([, v]) => !isRelated(v)),
      ),
    create: (target, overrides, scope) =>
      create(target, overrides as Record<string, unknown> | undefined, scope),
    async createMany(target, count, overrides, scope) {
      if (!Number.isInteger(count) || count < 0)
        throw new RangeError('createMany(count): count must be a non-negative integer')
      const out: InferModel<M>[] = []
      for (let i = 0; i < count; i++)
        out.push(await create(target, overrides as Record<string, unknown> | undefined, scope))
      return out
    },
  }
  return Object.freeze(factory)
}
