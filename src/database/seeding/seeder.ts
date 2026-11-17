/**
 * Seeders for migration-first apps (CONSISTENCY #88 and #104):
 *
 * ```ts
 * // database/seeders/post.seeder.ts
 * export default defineSeeder({
 *   after: ['users'],
 *   async run({ env }) {
 *     await PostFactory.count(env === 'production' ? 0 : 20).create()
 *   },
 * })
 *
 * // database/seeders/database.seeder.ts (the call list is kept in order by node strut)
 * export default defineSeeder({
 *   async run({ call }) {
 *     // strut:seeders:start
 *     await call([UsersSeeder, PostsSeeder])
 *     // strut:seeders:end
 *   },
 * })
 * ```
 *
 * `node strut db:seed` runs `database.seeder.ts`; `--class=PostSeeder` runs one seeder;
 * `--tenant=<id>` runs inside that tenant (the ORM's tenant scope and PostgreSQL RLS apply);
 * `--force` is required when `APP_ENV=production`. A seeder runs at most once per run, however
 * often it is called.
 *
 * @module
 */
import type { Connection } from '../db/connection.ts'
import type { Faker } from './faker.ts'

/** What a migration-first seeder's `run` receives. */
export interface SeedContext {
  /** The ORM connection the run uses (models use it too). */
  readonly db: Connection
  /** `APP_ENV` (`local`, `testing`, `staging`, `production`), or `undefined`. */
  readonly env: string | undefined
  /** The tenant this run seeds (`--tenant`), or `undefined`. */
  readonly tenantId: string | undefined
  /** A fake-data generator (the same one factories get). */
  readonly faker: Faker
  /** Run other seeders, in order; each runs once per `db:seed` however often it is called. */
  call(seeders: SeederLike | readonly SeederLike[]): Promise<void>
}

/** A seeder as the runner sees it (both v1 and migration-first seeders have this shape). */
export interface SeederLike {
  readonly name: string
  /** Tables whose seeders must run first (used to keep `database.seeder.ts` in order). */
  readonly after?: readonly string[]
  run(context: never): Promise<void> | void
}
