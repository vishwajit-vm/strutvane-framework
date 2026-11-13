/**
 * `factory(Model)`: build and persist valid records with sensible, deterministic values per field
 * kind, so tests state only what matters:
 *
 * ```ts
 * const paid = await factory(Invoice).state({ status: 'paid' }).count(3).create()
 * ```
 *
 * Required `belongsTo` fields create their target through its own factory unless given.
 *
 * @module
 */
import type { DataRecord, Repository, Scope } from '../data/repository.ts'
import type { AnyModel, CreateInput, InferModel, ModelDefinition } from '../model/define-model.ts'
import type { FieldDef } from '../model/field.ts'

/** Resolves repositories by model name (provided by the test app). */
export type RepositoryLookup = (model: string) => Repository

/** A chainable record factory. */
export interface Factory<M extends AnyModel> {
  /** Override values for every record. */
  state(values: Partial<CreateInput<M>>): Factory<M>
  /** How many records `create()` makes (default 1; `create()` then returns an array). */
  count(n: number): Factory<M>
  /** The tenant to create records in. */
  forTenant(tenantId: string): Factory<M>
  /** Values without saving. */
  make(): Record<string, unknown>
  /** Persist one record. */
  create(): Promise<InferModel<M>>
  /** Persist `count` records. */
  createMany(): Promise<InferModel<M>[]>
}

let sequence = 0

/** A valid value for a field (deterministic per call order). */
export function fakeValue(key: string, def: FieldDef, n: number): unknown {
  if (def.default !== undefined) return def.default
  switch (def.kind) {
    case 'string':
      return `${key}-${n}`.slice(0, def.max ?? def.length ?? 255).padEnd(def.min ?? 0, 'x')
    case 'text':
      return `${key} ${n}`.padEnd(def.min ?? 0, 'x')
    case 'email':
      return `user${n}@example.test`
    case 'url':
      return `https://example.test/${key}/${n}`
    case 'uuid':
      return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    case 'integer':
      return Math.max(def.min ?? 0, Math.min(def.max ?? 1_000_000, n))
    case 'bigInteger':
      return String(Math.max(def.min ?? 0, n))
    case 'decimal': {
      const v = Math.max(def.min ?? 0, Math.min(def.max ?? 9999, n))
      return v.toFixed(def.scale ?? 2)
    }
    case 'float':
      return Math.max(def.min ?? 0, n + 0.5)
    case 'boolean':
      return n % 2 === 0
    case 'enum':
      return def.values?.[0] ?? ''
    case 'date':
      return `2026-01-${String((n % 28) + 1).padStart(2, '0')}`
    case 'datetime':
      return new Date(Date.UTC(2026, 0, 1, 0, 0, n % 60)).toISOString()
    case 'json':
      return { n }
    case 'belongsTo':
      return undefined
  }
}

/** Create a factory for a model. */
export function createFactory<M extends AnyModel>(
  model: M | ModelDefinition,
  repos: RepositoryLookup,
  defaults: { readonly tenantId?: string } = {},
): Factory<M> {
  const definition: ModelDefinition = 'definition' in model ? model.definition : model
  const build = (overrides: Record<string, unknown>, n: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [key, def] of Object.entries(definition.fields)) {
      if (Object.hasOwn(overrides, key)) continue
      if (!def.required && def.default === undefined) continue
      const v = fakeValue(key, def, n)
      if (v !== undefined) out[key] = v
    }
    return { ...out, ...overrides }
  }
  const make = (
    values: Record<string, unknown>,
    count: number,
    tenantId: string | undefined,
  ): Factory<M> => {
    const scope: Scope = tenantId !== undefined ? { tenantId } : {}
    const createOne = async (): Promise<InferModel<M>> => {
      const n = ++sequence
      const input = build(values, n)
      for (const [key, def] of Object.entries(definition.fields)) {
        if (def.kind !== 'belongsTo' || !def.required || input[key] !== undefined) continue
        const target = repos(def.target ?? '').model
        const parent = await createFactory(
          target,
          repos,
          tenantId !== undefined ? { tenantId } : {},
        ).create()
        input[key] = (parent as unknown as DataRecord).id
      }
      return (await repos(definition.name).create(input, scope)) as unknown as InferModel<M>
    }
    return {
      state: (v) => make({ ...values, ...(v as Record<string, unknown>) }, count, tenantId),
      count: (c) => {
        if (!Number.isInteger(c) || c < 1) throw new RangeError('count must be a positive integer')
        return make(values, c, tenantId)
      },
      forTenant: (t) => make(values, count, t),
      make: () => build(values, ++sequence),
      create: createOne,
      async createMany() {
        const out: InferModel<M>[] = []
        for (let i = 0; i < count; i++) out.push(await createOne())
        return out
      },
    }
  }
  return make({}, 1, defaults.tenantId)
}
