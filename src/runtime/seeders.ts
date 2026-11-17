/**
 * Seeders (`database/seeders/*.seeder.ts`) and hand-written migration declarations.
 *
 * ```ts
 * import { defineSeeder } from '@strutvane/framework/database'
 * import InvoiceFactory from '../factories/invoice.factory.ts'
 * export default defineSeeder('InvoiceSeeder', async ({ create, scope }) => {
 *   await create(InvoiceFactory, 10, scope)
 * })
 * ```
 *
 * In a tenancy app, tenant-scoped models are seeded for one tenant at a time:
 * `sv db:seed --tenant <id>` puts `{ tenantId }` in `scope`, which seeders pass on (without it,
 * `sv db:seed` says which flag is missing instead of failing with `tenant_required`).
 *
 * `sv db:seed` runs `database/seeders/database.seeder.ts`, which calls the others in order
 * (`sv make:model` registers each new model's seeder there, after the seeders of the models it
 * belongs to):
 *
 * ```ts
 * import { defineSeeder } from '@strutvane/framework/database'
 * import CustomerSeeder from './customer.seeder.ts'
 * import InvoiceSeeder from './invoice.seeder.ts'
 * export default defineSeeder('DatabaseSeeder', async ({ call }) => {
 *   await call(CustomerSeeder)
 *   await call(InvoiceSeeder) // its factory's related('Customer') reuses those customers
 * })
 * ```
 *
 * `sv db:seed --class InvoiceSeeder` runs one seeder by name. When `DatabaseSeeder` runs nothing
 * while other seeder files exist, `sv db:seed` warns and names them.
 *
 * The string form `defineSeeder('Name', async (ctx) => …)` is the documented shape everywhere
 * (starter, `sv make:*`, docs); the object form `defineSeeder({ name?, run })` stays supported.
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
  /**
   * The tenant this run seeds (`sv db:seed --tenant <id>`), or `undefined`. Tenant-scoped models
   * refuse to be written without one (`tenant_required`).
   */
  readonly tenantId: string | undefined
  /**
   * `{ tenantId }` of this run (`{}` without `--tenant`). Pass it on: `create(F, 10, scope)`,
   * `repository(Model).create(input, scope)`. Generated seeders do.
   */
  readonly scope: Scope
  repository(model: AnyModel | string): Repository
  /** Create `count` records (default 1) with a factory, in `scope` (default: the run's scope). */
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

/**
 * What a hand-written migration receives: the migrator's transaction. Use `db.execute(sql, params)`
 * for DDL and data changes. (The `schema` builder sketched in docs/06 §3.2 is not built yet.)
 */
export interface MigrationContext {
  readonly db: Database
}

/** A hand-written TypeScript migration. */
export interface MigrationDefinition {
  up(context: MigrationContext): Promise<void> | void
  down?(context: MigrationContext): Promise<void> | void
}

/**
 * Declare a hand-written migration (`database/migrations/<timestamp>_<name>.ts`). `sv migrate`
 * runs `up({ db })` in timestamp order inside its transaction. `down()` is kept for the planned
 * rollback command and is not run today.
 */
export function defineMigration(definition: MigrationDefinition): MigrationDefinition {
  if (typeof definition?.up !== 'function')
    throw new TypeError('defineMigration needs an up() function')
  return Object.freeze({ ...definition })
}

/** Is `value` a migration definition? */
export function isMigrationDefinition(value: unknown): value is MigrationDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MigrationDefinition).up === 'function'
  )
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
  deps: {
    readonly db: Database
    readonly registry: ModelRegistry
    readonly ids: () => string
    /** Seed tenant-scoped models for this tenant (`sv db:seed --tenant <id>`). */
    readonly tenantId?: string
  },
): Promise<string[]> {
  const repos = new Map<string, Repository>()
  const ran: string[] = []
  const scope: Scope = deps.tenantId !== undefined ? { tenantId: deps.tenantId } : {}
  const context: SeederContext = {
    db: deps.db,
    tenantId: deps.tenantId,
    scope,
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
    create: (factory, count = 1, within = scope) =>
      factory.createMany(context, count, undefined, within),
    async call(next) {
      if (ran.includes(next.name)) return
      ran.push(next.name)
      await next.run(context)
    },
  }
  await context.call(seeder)
  return ran
}
