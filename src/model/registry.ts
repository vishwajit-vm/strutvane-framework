/**
 * The runtime model registry: the set of models an app exposes, validated as a whole.
 *
 * Individual models are validated by `defineModel`; this validates what only makes sense for the
 * set: unique names/tables/paths, `belongsTo`/`hasMany` targets that exist, back-references that
 * point at real `belongsTo` fields, and an order in which tables can be created (targets first).
 * The CLI's compiled registry (`.strutvane/registry.gen.ts`, ADR-0010) feeds models in here.
 *
 * @module
 */
import { type AnyModel, hiddenFieldProblem, type ModelDefinition } from './define-model.ts'

/** A validated, ordered set of models. */
export interface ModelRegistry {
  /** Every model definition, in dependency order (belongsTo targets first). */
  readonly all: readonly ModelDefinition[]
  /** Look a model up by name (`Invoice`). */
  get(name: string): ModelDefinition | undefined
  /** Like {@link ModelRegistry.get}, but throws for an unknown name. */
  require(name: string): ModelDefinition
  /** Look a model up by API path (`invoices`). */
  byPath(path: string): ModelDefinition | undefined
}

/** Order definitions so that every belongsTo target comes before the models that reference it. */
export function dependencyOrder(models: readonly ModelDefinition[]): ModelDefinition[] {
  const byName = new Map(models.map((m) => [m.name, m]))
  const out: ModelDefinition[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (m: ModelDefinition, path: readonly string[]): void => {
    const s = state.get(m.name)
    if (s === 'done') return
    if (s === 'visiting')
      throw new Error(`Cyclic belongsTo chain: ${[...path, m.name].join(' -> ')}`)
    state.set(m.name, 'visiting')
    for (const f of Object.values(m.fields)) {
      if (f.kind === 'belongsTo' && f.target && f.target !== m.name) {
        const target = byName.get(f.target)
        if (target) visit(target, [...path, m.name])
      }
    }
    state.set(m.name, 'done')
    out.push(m)
  }
  for (const m of models) visit(m, [])
  return out
}

/** Validate a set of models. Throws one error listing every problem found. */
export function validateModels(models: readonly ModelDefinition[]): void {
  const problems: string[] = []
  const unique = (what: string, values: readonly string[]): void => {
    const seen = new Set<string>()
    for (const v of values) {
      if (seen.has(v)) problems.push(`duplicate ${what} "${v}"`)
      seen.add(v)
    }
  }
  unique(
    'model name',
    models.map((m) => m.name),
  )
  unique(
    'table',
    models.map((m) => m.table),
  )
  unique(
    'API path',
    models.map((m) => m.path),
  )

  const byName = new Map(models.map((m) => [m.name, m]))
  for (const m of models) {
    for (const [key, f] of Object.entries(m.fields)) {
      // Plain definitions (snapshots, hand-written) skip defineModel, so check exposure here too.
      const exposure = hiddenFieldProblem(f)
      if (exposure) problems.push(`${m.name}.${key} ${exposure}`)
      if (f.kind === 'belongsTo' && !byName.has(f.target ?? '')) {
        problems.push(`${m.name}.${key} belongsTo unknown model "${f.target}"`)
      }
    }
    for (const [key, rel] of Object.entries(m.relations)) {
      const target = byName.get(rel.target)
      if (!target) {
        problems.push(`${m.name}.${key} hasMany unknown model "${rel.target}"`)
        continue
      }
      const back = target.fields[rel.foreignKey]
      if (back?.kind !== 'belongsTo' || back.target !== m.name) {
        problems.push(
          `${m.name}.${key} hasMany ${rel.target}: ${rel.target}.${rel.foreignKey} must be belongsTo('${m.name}')`,
        )
      }
    }
  }
  if (problems.length > 0) throw new Error(`Invalid models:\n  - ${problems.join('\n  - ')}`)
  dependencyOrder(models) // throws on cycles
}

/** Create a registry from defined models (or plain definitions, e.g. from a snapshot). */
export function createModelRegistry(
  models: readonly (AnyModel | ModelDefinition)[],
): ModelRegistry {
  const definitions = models.map((m) => ('definition' in m ? m.definition : m))
  validateModels(definitions)
  const ordered = Object.freeze(dependencyOrder(definitions))
  const byName = new Map(ordered.map((m) => [m.name, m]))
  const byPath = new Map(ordered.map((m) => [m.path, m]))
  return {
    all: ordered,
    get: (name) => byName.get(name),
    require(name) {
      const m = byName.get(name)
      if (!m) throw new Error(`Unknown model "${name}"`)
      return m
    },
    byPath: (path) => byPath.get(path),
  }
}
