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
 * `node strut db:seed --tenant <id>` puts `{ tenantId }` in `scope`, which seeders pass on (without it,
 * `node strut db:seed` says which flag is missing instead of failing with `tenant_required`).
 *
 * `node strut db:seed` runs `database/seeders/database.seeder.ts`, which calls the others in order
 * (`node strut make:model` registers each new model's seeder there, after the seeders of the models it
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
 * `node strut db:seed --class InvoiceSeeder` runs one seeder by name. When `DatabaseSeeder` runs nothing
 * while other seeder files exist, `node strut db:seed` warns and names them.
 *
 * The string form `defineSeeder('Name', async (ctx) => …)` is the documented shape everywhere
 * (starter, `node strut make:*`, docs); the object form `defineSeeder({ name?, run })` stays supported.
 *
 * @module
 */
import type { Repository, Scope } from '../data/repository.ts'
import { createRepository } from '../data/repository.ts'
import type { SeedContext } from '../database/seeding/seeder.ts'
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
   * The tenant this run seeds (`node strut db:seed --tenant <id>`), or `undefined`. Tenant-scoped models
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
  /**
   * Tables whose seeders must run first (migration-first apps, CONSISTENCY #88). Used to keep the
   * `call([...])` list in `database.seeder.ts` in dependency order.
   */
  readonly after?: readonly string[]
  /** `true` when no name was given: the runner names it after its file (`post.seeder.ts` → `PostSeeder`). */
  readonly anonymous?: boolean
  run(context: SeederContext): Promise<void> | void
}

/**
 * Define a seeder.
 *
 * - **Migration-first apps (the ORM, CONSISTENCY #88):** `defineSeeder({ after?, run })`; `run`
 *   receives `{ db, env, tenantId, faker, call }` and uses models and factories. Without a name,
 *   the seeder is named after its file (`post.seeder.ts` → `PostSeeder`; `database.seeder.ts` →
 *   `DatabaseSeeder`).
 * - **v1 apps (`defineModel`):** `defineSeeder('InvoiceSeeder', async (ctx) => …)` with the
 *   repository context. *Deprecated with the v1 model layer.*
 *
 * @example
 * export default defineSeeder({ after: ['users'], async run() { await PostFactory.count(20).create() } })
 */
export function defineSeeder(seeder: {
  readonly name?: string
  readonly after?: readonly string[]
  run(context: SeedContext): Promise<void> | void
}): Seeder
export function defineSeeder(name: string, run: Seeder['run']): Seeder
export function defineSeeder(
  first:
    | string
    | {
        readonly name?: string
        readonly after?: readonly string[]
        run(context: SeedContext): Promise<void> | void
      },
  run?: Seeder['run'],
): Seeder {
  if (typeof first === 'object' && first !== null && first.after !== undefined) {
    if (
      !Array.isArray(first.after) ||
      first.after.some((t) => !/^[a-z_][a-z0-9_]*$/.test(String(t)))
    )
      throw new TypeError('defineSeeder({ after }) takes table names, e.g. after: ["users"]')
  }
  const seeder =
    typeof first === 'string'
      ? { name: first, run }
      : {
          name: first.name ?? 'DatabaseSeeder',
          ...(first.name === undefined ? { anonymous: true } : {}),
          ...(first.after !== undefined ? { after: Object.freeze([...first.after]) } : {}),
          // The runner passes the context that matches the app (ORM or v1).
          run: first.run as unknown as Seeder['run'],
        }
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
 * Declare a hand-written migration (`database/migrations/<timestamp>_<name>.ts`). `node strut migrate`
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
    /** Seed tenant-scoped models for this tenant (`node strut db:seed --tenant <id>`). */
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
