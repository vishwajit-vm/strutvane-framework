/**
 * Running migration-first seeders (`node strut db:seed`, `migrate --seed`).
 *
 * - The whole run is **one transaction**: a seeder that fails leaves nothing half-seeded.
 * - With a tenant (`--tenant`), it runs inside `runWithTenant`, so the ORM's tenant scope fills
 *   and checks the tenant column and PostgreSQL row-level security applies (ADR-0007).
 * - Each seeder runs at most once per run, however often `call()` names it.
 * - Seeders without a name are named after their file (`post.seeder.ts` → `PostSeeder`).
 *
 * @module
 */
import type { Seeder } from '../../runtime/seeders.ts'
import type { Connection } from '../db/connection.ts'
import { useConnection } from '../db/manager.ts'
import { runWithTenant } from '../orm/tenancy.ts'
import { runWithoutTenant } from '../orm/tenant-scope.ts'
import { createFaker } from './faker.ts'
import type { SeedContext, SeederLike } from './seeder.ts'

/** Options for {@link runSeeders}. */
export interface RunSeedersOptions {
  readonly connection: Connection
  /** `APP_ENV`, passed to seeders as `env`. */
  readonly env: string | undefined
  /** Seed inside this tenant (`--tenant`). */
  readonly tenantId?: string
  /** Names for anonymous seeders, by identity (from their file names). */
  readonly names?: ReadonlyMap<SeederLike, string>
  /** Make fake data reproducible. */
  readonly seed?: number
}

/** `post.seeder.ts` → `PostSeeder`, `invoice-line.seeder.ts` → `InvoiceLineSeeder`. */
export function seederNameForFile(file: string): string {
  const base = file.replace(/\.seeder\.ts$/, '')
  return `${base
    .split(/[-_.]/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}Seeder`
}

/**
 * Run `root` (usually `DatabaseSeeder`) and every seeder it calls. Resolves to the names that
 * ran, in order.
 *
 * @example
 * const ran = await runSeeders(databaseSeeder, { connection, env: 'local' })
 */
export async function runSeeders(root: Seeder, options: RunSeedersOptions): Promise<string[]> {
  const ran: string[] = []
  const done = new Set<SeederLike>()
  const faker = createFaker(options.seed)
  const nameOf = (seeder: SeederLike): string =>
    (seeder as Seeder).anonymous === true
      ? (options.names?.get(seeder) ?? seeder.name)
      : seeder.name
  const context: SeedContext = {
    db: options.connection,
    env: options.env,
    tenantId: options.tenantId,
    faker,
    async call(seeders) {
      const list: readonly SeederLike[] = Array.isArray(seeders) ? seeders : [seeders as SeederLike]
      for (const seeder of list) {
        if (typeof seeder?.run !== 'function')
          throw new TypeError(
            'call() takes seeders (the default exports of database/seeders/*.seeder.ts).',
          )
        if (done.has(seeder)) continue
        done.add(seeder)
        ran.push(nameOf(seeder))
        await (seeder.run as (context: SeedContext) => Promise<void> | void)(context)
      }
    },
  }
  useConnection(options.connection)
  const work = (): Promise<void> => options.connection.transaction(() => context.call(root))
  // Seeders without --tenant run with no tenant on purpose (they create the tenants, global data
  // and the first rows of every tenant), so their hand-written SQL may name tenant tables.
  if (options.tenantId === undefined) await runWithoutTenant('seeders', work)
  else await runWithTenant(options.tenantId, work)
  return ran
}
