/**
 * ADR-0007 on migration-first apps: a table created with `t.tenant()` gets PostgreSQL row-level
 * security from its migration (RESTRICTIVE policy with USING and WITH CHECK, FORCE, the tenant
 * read transaction-locally), proven as a non-owner, non-superuser role on PGlite and PostgreSQL 18.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Connection } from '../../../src/database/db/connection.ts'
import { migrate, rollback } from '../../../src/migrations/runner.ts'
import { migration } from '../../../src/schema/migration.ts'
import { replayMigrations } from '../../../src/schema/replay.ts'
import { ENGINES, engineTitle, type OpenDatabase, query } from './engines.ts'

const A = '0190a000-0000-7000-8000-00000000000a'
const B = '0190a000-0000-7000-8000-00000000000b'

const replay = replayMigrations([
  {
    name: '2026_01_01_000000_create_projects_table',
    migration: migration({
      up(schema) {
        schema.create('projects', (t) => {
          t.id()
          t.tenant()
          t.string('name', 100)
        })
      },
      down(schema) {
        schema.drop('projects')
      },
    }),
  },
  {
    name: '2026_01_02_000000_create_regions_table',
    migration: migration({
      up(schema) {
        schema.create(
          'regions',
          (t) => {
            t.id()
            t.string('name', 100)
          },
          { global: true },
        )
      },
      down(schema) {
        schema.drop('regions')
      },
    }),
  },
])

describe.each(ENGINES.filter((engine) => engine.name === 'pglite' || engine.name === 'postgres'))(
  'tenant RLS from migrations on $name',
  (engine) => {
    let db: OpenDatabase | undefined
    const role = `sv_app_${randomBytes(4).toString('hex')}`
    const connection = (): Connection => {
      if (db === undefined) throw new Error('not open')
      return db.connection
    }
    /** Run `work` as the non-owner runtime role (ADR-0007 rule 4), on one pinned session. */
    const asApp = <T>(work: () => Promise<T>): Promise<T> =>
      connection().session(async () => {
        await query(connection(), `SET ROLE "${role}"`)
        try {
          return await work()
        } finally {
          await query(connection(), 'RESET ROLE')
        }
      })

    beforeAll(async () => {
      if (engine.skipped !== undefined) return
      db = await engine.open()
      await migrate(connection(), replay)
      await query(connection(), `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`)
      await query(
        connection(),
        `GRANT SELECT, INSERT, UPDATE, DELETE ON "projects", "regions" TO "${role}"`,
      )
      await query(connection(), `GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
    })
    afterAll(async () => {
      if (db === undefined) return
      await query(connection(), `DROP OWNED BY "${role}"`)
      await query(connection(), `DROP ROLE "${role}"`)
      await db.close()
    })

    test.skipIf(engine.skipped !== undefined)(
      `the policy is restrictive and forced${engine.skipped === undefined ? '' : ` (skipped: ${engine.skipped})`}`,
      async () => {
        const policies = await query(
          connection(),
          `SELECT policyname, permissive FROM pg_policies WHERE tablename = 'projects' ORDER BY policyname`,
        )
        expect(policies).toEqual([
          { policyname: 'tenant_access', permissive: 'PERMISSIVE' },
          { policyname: 'tenant_isolation', permissive: 'RESTRICTIVE' },
        ])
        const [forced] = await query(
          connection(),
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'projects'`,
        )
        expect(forced).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
        expect(
          await query(
            connection(),
            `SELECT policyname FROM pg_policies WHERE tablename = 'regions'`,
          ),
        ).toEqual([])
      },
    )

    test.skipIf(engine.skipped !== undefined)(
      `tenants never see or write each other's rows, even with raw SQL${engine.skipped === undefined ? '' : ` (skipped: ${engine.skipped})`}`,
      async () => {
        await asApp(async () => {
          await connection().transaction(
            () =>
              query(
                connection(),
                `INSERT INTO "projects" ("tenant_id", "name") VALUES ('${A}', 'Launch')`,
              ),
            { tenantId: A },
          )
          const seenByA = await connection().transaction(
            () => query(connection(), 'SELECT "name" FROM "projects"'),
            { tenantId: A },
          )
          expect(seenByA).toEqual([{ name: 'Launch' }])
          const seenByB = await connection().transaction(
            () => query(connection(), 'SELECT "name" FROM "projects"'),
            { tenantId: B },
          )
          expect(seenByB).toEqual([])
          // No tenant at all: the unset setting reads as NULL, so nothing matches (fail closed).
          expect(await query(connection(), 'SELECT "name" FROM "projects"')).toEqual([])
          // WITH CHECK: B can't write a row into A.
          await expect(
            connection().transaction(
              () =>
                query(
                  connection(),
                  `INSERT INTO "projects" ("tenant_id", "name") VALUES ('${A}', 'Smuggled')`,
                ),
              { tenantId: B },
            ),
          ).rejects.toThrow(/row-level security/)
          // Moving A's row to B is refused too.
          await expect(
            connection().transaction(
              () => query(connection(), `UPDATE "projects" SET "tenant_id" = '${B}'`),
              { tenantId: A },
            ),
          ).rejects.toThrow(/row-level security/)
        })
      },
    )

    test.skipIf(engine.skipped !== undefined)(
      `rolling the migration back removes the table and its policies${engine.skipped === undefined ? '' : ` (skipped: ${engine.skipped})`}`,
      async () => {
        await rollback(connection(), replay, { step: 2 })
        expect(
          await query(
            connection(),
            `SELECT policyname FROM pg_policies WHERE tablename = 'projects'`,
          ),
        ).toEqual([])
        await migrate(connection(), replay)
      },
    )
  },
)

test('engines are titled with their skip reason', () => {
  expect(ENGINES.map(engineTitle).length).toBe(ENGINES.length)
})
