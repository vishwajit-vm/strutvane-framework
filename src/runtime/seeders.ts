/**
 * Seeders (`database/seeders/*.seeder.ts`) and hand-written migration declarations.
 *
 * ```ts
 * import { defineSeeder } from '@strutvane/framework/database'
 * import InvoiceFactory from '../factories/invoice.factory.ts'
 * export default defineSeeder('InvoiceSeeder', async ({ create }) => {
 *   await create(InvoiceFactory, 10)
 * })
 * ```
 *
 * `sv db:seed` runs `database/seeders/database.seeder.ts` (which orchestrates the order);
 * `sv db:seed --class InvoiceSeeder` runs one seeder by name.
 *
 * @module
 */
import type { Repository, Scope } from '../data/repository.ts'
import { createRepository } from '../data/repository.ts'
import type { Database } from '../database/types.ts'
import type { AnyModel } from '../model/define-model.ts'
import type { ModelRegistry } from '../model/registry.ts'

/** Something `create()` can build records with (a `defineFactory()` result). */
export interface SeedFactory {
  createMany(
    target: SeederContext,
    count: number,
    overrides?: never,
    scope?: Scope,
  ): Promise<unknown[]>
}

/** What a seeder receives. */
export interface SeederContext {
  readonly db: Database
  repository(model: AnyModel | string): Repository
  /** Create `count` records (default 1) with a factory. */
  create(factory: SeedFactory, count?: number, scope?: Scope): Promise<unknown[]>
  /** Run another seeder (for `database.seeder.ts` orchestration). */
  call(seeder: Seeder): Promise<void>
}

/** A seeder. */
export interface Seeder {
  readonly name: string
  run(context: SeederContext): Promise<void> | void
}

/**
 * Define a seeder: `defineSeeder('InvoiceSeeder', async (ctx) => …)`, or
 * `defineSeeder({ name?, run })` (the name defaults to `DatabaseSeeder`).
 */
export function defineSeeder(name: string, run: Seeder['run']): Seeder
export function defineSeeder(seeder: {
  readonly name?: string
  readonly run: Seeder['run']
}): Seeder
export function defineSeeder(
  first: string | { readonly name?: string; readonly run: Seeder['run'] },
  run?: Seeder['run'],
): Seeder {
  const seeder =
    typeof first === 'string'
      ? { name: first, run }
      : { name: first.name ?? 'DatabaseSeeder', run: first.run }
  if (!/^[A-Z][A-Za-z0-9]*$/.test(seeder.name))
    throw new TypeError(`Seeder name "${seeder.name}" must be PascalCase (e.g. "InvoiceSeeder")`)
  if (typeof seeder.run !== 'function')
    throw new TypeError(`Seeder ${seeder.name} needs a run function`)
  return Object.freeze(seeder as Seeder)
}

/** Context for a hand-written migration (declared now, executed in a later release). */
export interface MigrationContext {
  readonly db: Database
}

/** A hand-written TypeScript migration. */
export interface MigrationDefinition {
  up(context: MigrationContext): Promise<void> | void
  down?(context: MigrationContext): Promise<void> | void
}

/**
 * Declare a hand-written migration. **Not executed by `sv migrate` yet**: it stops with a clear
 * error instead of silently skipping the file. Use `sv make:migration --sql` meanwhile.
 */
export function defineMigration(definition: MigrationDefinition): MigrationDefinition {
  if (typeof definition?.up !== 'function')
    throw new TypeError('defineMigration needs an up() function')
  return Object.freeze({ ...definition })
}

/** Is `value` a seeder? */
export function isSeeder(value: unknown): value is Seeder {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Seeder).name === 'string' &&
    typeof (value as Seeder).run === 'function'
  )
}

/** Run `seeder` against `db`. Each seeder runs once per call tree, even if called twice. */
export async function runSeeder(
  seeder: Seeder,
  deps: { readonly db: Database; readonly registry: ModelRegistry; readonly ids: () => string },
): Promise<string[]> {
  const repos = new Map<string, Repository>()
  const ran: string[] = []
  const context: SeederContext = {
    db: deps.db,
    repository(model) {
      const name = typeof model === 'string' ? model : model.definition.name
      let repo = repos.get(name)
      if (!repo) {
        repo = createRepository({
          db: deps.db,
          model: deps.registry.require(name),
          registry: deps.registry,
          ids: deps.ids,
        })
        repos.set(name, repo)
      }
      return repo
    },
    create: (factory, count = 1, scope) => factory.createMany(context, count, undefined, scope),
    async call(next) {
      if (ran.includes(next.name)) return
      ran.push(next.name)
      await next.run(context)
    },
  }
  await context.call(seeder)
  return ran
}
