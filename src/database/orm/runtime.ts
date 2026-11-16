/**
 * The runtime contracts between the builder, the relations and the model class.
 *
 * They live in their own module (with no runtime imports) so `builder.ts`, `relations.ts` and
 * `model.ts` can all depend on it without an import cycle: the builder only ever sees a
 * {@link ModelRuntime} (the static side of a model) and a {@link RelationContract}.
 */
import type { Connection } from '../db/connection.ts'
import type { Row } from '../db/driver.ts'
import type { TableInfo } from '../schema/registry.ts'
import type { SelectAst } from '../sql/ast.ts'
import type { Cast } from './casts.ts'
import type { ModelBase } from './model.ts'

/** Brands the static side of every model class (checked with `MODEL_BRAND in value`). */
export const MODEL_BRAND: '~strutvane.model' = '~strutvane.model'
/** Brands every relation object. */
export const RELATION_BRAND: '~strutvane.relation' = '~strutvane.relation'

/**
 * A scope or constraint callback, stored without its precise type. The builder calls these
 * with `Reflect.apply`; their precise types are enforced where the developer writes them.
 */
export type StoredCallback = (...args: never[]) => unknown

/**
 * A model's options, validated and normalised once per class.
 *
 * @example
 * settings.fillable?.has('title')
 */
export interface ModelSettings {
  /** `undefined` means "no fillable declared": `create()`/`fill()` refuse everything. */
  readonly fillable: ReadonlySet<string> | undefined
  readonly hidden: ReadonlySet<string>
  readonly casts: ReadonlyMap<string, Cast<unknown>>
  readonly perPage: number
  readonly scopes: ReadonlyMap<string, StoredCallback>
  readonly globalScopes: ReadonlyMap<string, StoredCallback>
}

/**
 * The static side of a model class, as the builder and relations use it.
 *
 * @example
 * const runtime: ModelRuntime = Post // every model class is one
 */
export interface ModelRuntime {
  readonly '~strutvane.model': true
  readonly table: string
  readonly name: string
  readonly prototype: object
  info(): TableInfo
  settings(): ModelSettings
  hydrate(row: Row, fromList: boolean): ModelBase
  /** A new, unsaved instance. */
  make(): ModelBase
  connection(): Connection
  /** The relation named `name`, resolved safely (see `ModelBase.relation`). */
  relation(name: string): RelationContract
}

/**
 * Is this value a model class? (A brand check, so look-alike objects are rejected.)
 *
 * @example
 * isModelRuntime(Post) // true
 */
export function isModelRuntime(value: unknown): value is ModelRuntime {
  return typeof value === 'function' && MODEL_BRAND in value
}

/**
 * What every relation can do for the builder.
 *
 * @example
 * await relation.eagerLoad(posts, 'author', undefined)
 */
export interface RelationContract {
  readonly '~strutvane.relation': true
  /** Load this relation for all `parents` with one query; return the loaded models (for nesting). */
  eagerLoad(
    parents: readonly ModelBase[],
    name: string,
    constrain: StoredCallback | undefined,
  ): Promise<ModelBase[]>
  /** A correlated subquery against `parentAlias`, for `withCount` and `whereHas`. */
  subquery(
    parentAlias: string,
    alias: string,
    constrain: StoredCallback | undefined,
    kind: 'count' | 'exists',
  ): SelectAst
}

/**
 * Is this value a relation object?
 *
 * @example
 * isRelation(post.author()) // true
 */
export function isRelation(value: unknown): value is RelationContract {
  return typeof value === 'object' && value !== null && RELATION_BRAND in value
}

/**
 * Read one attribute of a model (columns, loaded relations and counts are own properties).
 *
 * @example
 * attribute(post, 'author_id') // 7
 */
export function attribute(model: object, key: string): unknown {
  const raw: unknown = Reflect.get(model, key)
  return raw
}

/**
 * Store a loaded relation or count on a model. It becomes an own, enumerable property, so it
 * shadows the relation *method* of the same name (exactly what `post.author` should mean once
 * loaded) and shows up in `toJSON()`.
 *
 * @example
 * setLoaded(post, 'author', user)
 */
export function setLoaded(model: object, key: string, value: unknown): void {
  Object.defineProperty(model, key, { value, enumerable: true, writable: true, configurable: true })
}
