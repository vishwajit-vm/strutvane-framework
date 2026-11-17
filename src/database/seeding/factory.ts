/**
 * Model factories for the ORM (Laravel's factories, CONSISTENCY #89):
 *
 * ```ts
 * // database/factories/post.factory.ts
 * export default defineFactory(Post, ({ faker, sequence }) => ({
 *   title: `${faker.sentence()} #${sequence}`,
 *   status: faker.pick(['draft', 'published']),
 *   author_id: UserFactory, // a parent per row, unless recycled
 * }))
 *
 * await PostFactory.count(10).for(user).create()
 * await PostFactory.state({ status: 'published' }).recycle(users).create()
 * await UserFactory.has(PostFactory.count(3)).create()
 * ```
 *
 * - Attributes are written with `forceCreate` (factories describe trusted test and seed data, so
 *   `fillable` doesn't apply, as in Laravel). Casts, slugs, timestamps and the tenant scope still
 *   do: in a tenancy app, create inside `runWithTenant` (`node strut db:seed --tenant <id>`).
 * - A foreign-key attribute may be another factory: one parent is created per row, unless
 *   `recycle(models)` supplies existing ones (which stops a seeder creating a new user for every
 *   post, the classic demo-data bug).
 * - Factories are immutable: every method returns a new factory, so a shared base is safe.
 *
 * @module
 */
import { OrmUsageError } from '../orm/errors.ts'
import type { ModelBase } from '../orm/model.ts'
import type { AnyModel, AnyModelClass, InstanceOf, TableOf } from '../orm/types.ts'
import type { InsertOf } from '../schema/registry.ts'
import { createFaker, type Faker } from './faker.ts'

/** What a definition receives: the fake-data generator and this row's 1-based sequence number. */
export interface FactoryContext {
  readonly faker: Faker
  readonly sequence: number
}

/** An attribute value in a definition or state: a value, or a factory for a foreign key. */
export type FactoryValue<TValue> = TValue | AnyFactory

/** The attributes a definition returns: the table's insert shape, foreign keys may be factories. */
export type FactoryAttributes<TClass extends AnyModelClass> = {
  [TColumn in keyof InsertOf<TableOf<TClass>>]?: FactoryValue<InsertOf<TableOf<TClass>>[TColumn]>
}

/** A state: fixed attributes, or a function of the row being built. */
export type FactoryState<TClass extends AnyModelClass> =
  | FactoryAttributes<TClass>
  | ((
      attributes: Readonly<Record<string, unknown>>,
      context: FactoryContext,
    ) => FactoryAttributes<TClass>)

/** Any factory (used where the model doesn't matter). */
export interface AnyFactory {
  readonly '~strutvane.factory': true
  readonly model: AnyModelClass
  /** Create one model, recycling or creating parents as configured. */
  createOne(context: FactoryRun): Promise<ModelBase>
}

/** Shared state of one `create()` call: recycled models and the faker. */
export interface FactoryRun {
  readonly faker: Faker
  readonly recycled: ReadonlyMap<AnyModelClass, readonly ModelBase[]>
  /** Rows built so far per definition in this run (each definition's `sequence` starts at 1). */
  readonly sequences: Map<unknown, number>
}

interface Child {
  readonly factory: AnyFactory
  readonly foreignKey: string | undefined
}

interface Settings<TClass extends AnyModelClass> {
  readonly model: TClass
  readonly define: (context: FactoryContext) => FactoryAttributes<TClass>
  readonly count: number
  /** `count()` was called: `create()` returns an array. */
  readonly many: boolean
  readonly states: readonly FactoryState<TClass>[]
  readonly parents: readonly {
    readonly model: ModelBase
    readonly foreignKey: string | undefined
  }[]
  readonly children: readonly Child[]
  readonly recycle: readonly ModelBase[]
  readonly seed: number | undefined
}

/** `post_tag` → `post_tag`, `categories` → `category`: the Laravel foreign-key guess. */
function singular(table: string): string {
  if (table.endsWith('ies')) return `${table.slice(0, -3)}y`
  if (table.endsWith('ses') || table.endsWith('xes')) return table.slice(0, -2)
  return table.endsWith('s') ? table.slice(0, -1) : table
}

function isFactory(value: unknown): value is AnyFactory {
  return typeof value === 'object' && value !== null && '~strutvane.factory' in value
}

function tableOfModel(model: ModelBase): string {
  return model.runtime().table
}

function keyOf(model: ModelBase): unknown {
  return (model as unknown as Record<string, unknown>)['id']
}

/**
 * A factory for one model. Build it with {@link defineFactory}.
 *
 * @example
 * const posts = await PostFactory.count(3).create()
 */
export class Factory<TClass extends AnyModelClass, TMany extends boolean = false>
  implements AnyFactory
{
  readonly '~strutvane.factory': true = true
  readonly #settings: Settings<TClass>

  constructor(settings: Settings<TClass>) {
    this.#settings = settings
  }

  /** The model this factory creates. */
  get model(): TClass {
    return this.#settings.model
  }

  #with(changes: Partial<Settings<TClass>>): Factory<TClass, TMany> {
    return new Factory<TClass, TMany>({ ...this.#settings, ...changes })
  }

  /**
   * How many models `create()` makes (default 1; then it returns an array of that length).
   *
   * @example
   * await PostFactory.count(5).create()
   */
  count(count: number): Factory<TClass, true> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100_000)
      throw new OrmUsageError(
        'invalid_count',
        `count() needs a whole number from 1 to 100000; got ${String(count)}.`,
      )
    return new Factory<TClass, true>({ ...this.#settings, count, many: true })
  }

  /**
   * Override attributes, for every row (Laravel's states).
   *
   * @example
   * PostFactory.state({ status: 'published' })
   */
  state(state: FactoryState<TClass>): Factory<TClass, TMany> {
    return this.#with({ states: [...this.#settings.states, state] })
  }

  /**
   * Belong to an existing parent: sets `<parent>_id` (or `foreignKey`) on every row.
   *
   * @example
   * await PostFactory.count(3).for(author, 'author_id').create()
   */
  for(parent: AnyModel, foreignKey?: string): Factory<TClass, TMany> {
    const model = parent as unknown as ModelBase
    return this.#with({ parents: [...this.#settings.parents, { model, foreignKey }] })
  }

  /**
   * Create children after each model: `UserFactory.has(PostFactory.count(3))` gives every user
   * three posts (`<this table>_id`, or `foreignKey`).
   *
   * @example
   * await UserFactory.has(PostFactory.count(2), 'author_id').create()
   */
  has(children: AnyFactory, foreignKey?: string): Factory<TClass, TMany> {
    return this.#with({ children: [...this.#settings.children, { factory: children, foreignKey }] })
  }

  /**
   * Reuse these models wherever a definition asks for a parent of their type, instead of creating
   * a new one per row.
   *
   * @example
   * const users = await UserFactory.count(5).create()
   * await PostFactory.count(50).recycle(users).create() // 50 posts spread over 5 users
   */
  recycle(models: AnyModel | readonly AnyModel[]): Factory<TClass, TMany> {
    const list = (Array.isArray(models) ? models : [models]) as unknown as readonly ModelBase[]
    return this.#with({ recycle: [...this.#settings.recycle, ...list] })
  }

  /**
   * Make the fake data reproducible.
   *
   * @example
   * await PostFactory.seed(42).create()
   */
  seed(seed: number): Factory<TClass, TMany> {
    return this.#with({ seed })
  }

  /**
   * The attributes the next rows would get, without saving anything (foreign-key factories are
   * left unresolved, as `undefined`).
   *
   * @example
   * const attributes = PostFactory.raw()
   */
  raw(): Record<string, unknown>[] {
    const run: FactoryRun = {
      faker: createFaker(this.#settings.seed),
      recycled: new Map(),
      sequences: new Map(),
    }
    return Array.from({ length: this.#settings.count }, () => {
      const attributes = this.#attributes(run)
      for (const [key, value] of Object.entries(attributes))
        if (isFactory(value)) attributes[key] = undefined
      return attributes
    })
  }

  /**
   * Create and save the models. One model without `count()`, an array with it.
   *
   * @example
   * const post = await PostFactory.create({ title: 'Pinned' })
   */
  async create(
    overrides?: FactoryAttributes<TClass>,
  ): Promise<TMany extends true ? InstanceOf<TClass>[] : InstanceOf<TClass>> {
    const factory = overrides === undefined ? this : this.state(overrides)
    const recycled = new Map<AnyModelClass, ModelBase[]>()
    for (const model of factory.#settings.recycle) {
      const ctor = model.constructor as unknown as AnyModelClass
      recycled.set(ctor, [...(recycled.get(ctor) ?? []), model])
    }
    const run: FactoryRun = {
      faker: createFaker(factory.#settings.seed),
      recycled,
      sequences: new Map(),
    }
    const created: ModelBase[] = []
    for (let i = 0; i < factory.#settings.count; i++) created.push(await factory.createOne(run))
    const result = factory.#settings.many ? created : created[0]
    return result as TMany extends true ? InstanceOf<TClass>[] : InstanceOf<TClass>
  }

  /** Create one model (used by parent and child factories). */
  async createOne(run: FactoryRun): Promise<ModelBase> {
    const attributes = this.#attributes(run)
    for (const parent of this.#settings.parents)
      attributes[parent.foreignKey ?? `${singular(tableOfModel(parent.model))}_id`] = keyOf(
        parent.model,
      )
    for (const [key, value] of Object.entries(attributes)) {
      if (!isFactory(value)) continue
      const pool = run.recycled.get(value.model)
      const parent =
        pool !== undefined && pool.length > 0
          ? (pool[Math.floor(Math.random() * pool.length)] as ModelBase)
          : await value.createOne(run)
      attributes[key] = keyOf(parent)
    }
    const model = (await (
      this.#settings.model as unknown as {
        forceCreate(input: object): Promise<ModelBase>
      }
    ).forceCreate(attributes)) as ModelBase
    for (const child of this.#settings.children) {
      const key = child.foreignKey ?? `${singular(tableOfModel(model))}_id`
      const childFactory = child.factory as Factory<AnyModelClass, boolean>
      const count = childFactory.#settings.count
      const bound = childFactory.state({ [key]: keyOf(model) } as FactoryAttributes<AnyModelClass>)
      for (let i = 0; i < count; i++) await bound.createOne(run)
    }
    return model
  }

  #attributes(run: FactoryRun): Record<string, unknown> {
    const sequence = (run.sequences.get(this.#settings.define) ?? 0) + 1
    run.sequences.set(this.#settings.define, sequence)
    const context: FactoryContext = { faker: run.faker, sequence }
    let attributes: Record<string, unknown> = { ...this.#settings.define(context) }
    for (const state of this.#settings.states) {
      const next = typeof state === 'function' ? state(attributes, context) : state
      attributes = { ...attributes, ...next }
    }
    return attributes
  }
}

/**
 * Define a factory for a model (CONSISTENCY #89).
 *
 * @example
 * export default defineFactory(Post, ({ faker, sequence }) => ({ title: `${faker.sentence()} ${sequence}` }))
 */
export function defineFactory<TClass extends AnyModelClass>(
  model: TClass,
  define: (context: FactoryContext) => FactoryAttributes<TClass>,
): Factory<TClass> {
  if (typeof define !== 'function')
    throw new OrmUsageError(
      'invalid_factory',
      'defineFactory(Model, ({ faker, sequence }) => ({ … })) needs a definition function.',
    )
  return new Factory({
    model,
    define,
    count: 1,
    many: false,
    states: [],
    parents: [],
    children: [],
    recycle: [],
    seed: undefined,
  })
}
