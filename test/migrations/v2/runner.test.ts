/**
 * The v2 migrator, run for real on SQLite, PGlite, PostgreSQL 18, MySQL 8.4 and MariaDB 11.4:
 * migrate, roll back step by step, prove at every step that the live database matches what the
 * recorder predicted offline, and exercise the failure paths (atomic migrations on PostgreSQL and
 * SQLite, resume on MySQL/MariaDB, drift, locks).
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { introspect, schemaDrift } from '../../../src/migrations/introspect.ts'
import {
  fresh,
  MIGRATIONS_TABLE,
  MigrationError,
  migrate,
  migrationChecksum,
  migrationStatus,
  ranMigrations,
  refresh,
  reset,
  rollback,
  stateAfter,
} from '../../../src/migrations/runner.ts'
import { migrationLock } from '../../../src/migrations/runner-sql.ts'
import { EMPTY_SCHEMA, type SchemaState } from '../../../src/schema/columns.ts'
import { createSchemaSql } from '../../../src/schema/ddl/ddl.ts'
import { migration } from '../../../src/schema/migration.ts'
import type { ReplayedStep } from '../../../src/schema/operations.ts'
import {
  discoverMigrations,
  type LoadedMigration,
  loadMigrations,
  type Replay,
  replayMigrations,
} from '../../../src/schema/replay.ts'
import { BLOG_ROOT, replayApp } from '../../schema/helpers.ts'
import { count, ENGINES, engineTitle, isMysql, type OpenDatabase, query } from './engines.ts'

/** A replay containing only the first `count` migrations, as if the rest didn't exist yet. */
function firstMigrations(replay: Replay, n: number): Replay {
  const migrations = replay.migrations.slice(0, n)
  return { migrations, state: stateAfter(replay, n) }
}

async function blogLoaded(): Promise<LoadedMigration[]> {
  return loadMigrations(discoverMigrations(join(BLOG_ROOT, 'database', 'migrations')))
}

/** The blog replay plus one more migration. */
async function blogWith(name: string, extra: LoadedMigration['migration']): Promise<Replay> {
  return replayMigrations([...(await blogLoaded()), { name, migration: extra }])
}

/** Two tenant tables with a composite foreign key between them (security review F-05). */
const tenantReplay = (): Replay =>
  replayMigrations([
    {
      name: '2026_02_01_000000_create_projects_table',
      migration: migration({
        up(schema) {
          schema.create('projects', (t) => {
            t.id()
            t.tenant()
            t.string('name', 100).unique()
          })
        },
        down(schema) {
          schema.dropIfExists('projects')
        },
      }),
    },
    {
      name: '2026_02_02_000000_create_tasks_table',
      migration: migration({
        up(schema) {
          schema.create('tasks', (t) => {
            t.id()
            t.tenant()
            t.foreignId('project_id').constrained('projects').cascadeOnDelete()
            t.string('title')
          })
        },
        down(schema) {
          schema.dropIfExists('tasks')
        },
      }),
    },
  ])

const noDrift = async (open: OpenDatabase, state: SchemaState): Promise<void> => {
  expect(
    schemaDrift(state, await introspect(open.connection), open.connection.grammar.dialect),
  ).toEqual([])
}

describe.each(ENGINES)('migrator on $name', (engine) => {
  let open: OpenDatabase | undefined
  afterEach(async () => {
    await open?.close()
    open = undefined
  })
  const freshDb = async (): Promise<OpenDatabase> => {
    open = await engine.open()
    return open
  }

  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => {
    test('migrate runs every migration as one batch, and the live schema matches the recorder exactly', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      const events: string[] = []
      const result = await migrate(db.connection, replay, {
        onEvent: (event) => events.push(event.type),
      })
      expect(result.ran).toHaveLength(7)
      expect(result.batch).toBe(1)
      expect(result.locked).toBe(false)
      expect(events).toContain('migrated')
      await noDrift(db, replay.state)
      // Running again is a no-op: nothing pending.
      expect((await migrate(db.connection, replay)).ran).toEqual([])
      const status = await migrationStatus(db.connection, replay)
      expect(status.pending).toEqual([])
      expect(status.drift).toEqual([])
      expect(status.ran.map((row) => row.batch)).toEqual([1, 1, 1, 1, 1, 1, 1])
    })

    test('one migration per batch, then roll back batch by batch: no drift at any step', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      for (let n = 1; n <= replay.migrations.length; n++) {
        const partial = firstMigrations(replay, n)
        expect((await migrate(db.connection, partial)).batch).toBe(n)
        await noDrift(db, partial.state)
      }
      for (const step of [...replay.migrations].reverse()) {
        expect((await rollback(db.connection, replay)).rolledBack).toEqual([step.name])
        await noDrift(db, step.before)
      }
      expect(await introspect(db.connection)).toEqual([])
      expect(await ranMigrations(db.connection)).toEqual([])
    })

    test('--step gives each migration its own batch; rollback --step and --batch pick them', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      const result = await migrate(db.connection, replay, { step: true })
      expect(result.batch).toBe(7)
      expect((await ranMigrations(db.connection)).map((row) => row.batch)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ])
      expect((await rollback(db.connection, replay, { step: 2 })).rolledBack).toEqual([
        replay.migrations[6]?.name,
        replay.migrations[5]?.name,
      ])
      expect((await rollback(db.connection, replay, { batch: 5 })).rolledBack).toEqual([
        replay.migrations[4]?.name,
      ])
      await noDrift(db, stateAfter(replay, 4))
      await expect(rollback(db.connection, replay, { step: 0 })).rejects.toThrow(RangeError)
    })

    test('--pretend shows the SQL and changes nothing (also for rollbacks)', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      const planned = await migrate(db.connection, replay, { pretend: true })
      expect(planned.ran).toEqual([])
      expect(planned.pretend.map((p) => p.migration)).toEqual(replay.migrations.map((s) => s.name))
      expect(planned.pretend[0]?.statements[0]).toMatch(/^CREATE TABLE/)
      // The blog's third migration drops "excerpt" and adds "subtitle": flagged, not refused.
      expect(planned.warnings.map((w) => w.code)).toEqual(['looks_like_rename'])
      expect(planned.warnings[0]?.hint).toMatch(/renameColumn\('excerpt', 'subtitle'\)/)
      expect(await introspect(db.connection)).toEqual([])
      await migrate(db.connection, replay)
      const undo = await rollback(db.connection, replay, { pretend: true })
      expect(undo.rolledBack).toEqual([])
      expect(undo.pretend).toHaveLength(7)
      expect(await count(db.connection, MIGRATIONS_TABLE)).toBe(7)
    })

    test('rows survive renames and the SQLite table rebuild on the way down', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      await migrate(db.connection, replay, { step: true })
      await query(
        db.connection,
        `INSERT INTO "users" ("name", "email") VALUES ('Ada', 'ada@example.com')`,
      )
      await query(
        db.connection,
        `INSERT INTO "categories" ("name", "slug") VALUES ('News', 'news')`,
      )
      await query(
        db.connection,
        `INSERT INTO "posts" ("title", "slug", "content", "author_id", "category_id") VALUES ('Hello', 'hello', 'Body text', 1, 1)`,
      )
      // Undo rename_labels, create_labels and add_category (the one that rebuilds posts on SQLite).
      for (let undo = 0; undo < 3; undo++) await rollback(db.connection, replay)
      await noDrift(db, stateAfter(replay, 4))
      const rows = await query(
        db.connection,
        `SELECT "title", "slug", "content", "author_id" FROM "posts"`,
      )
      expect(rows.map((row) => ({ ...row, author_id: Number(row['author_id']) }))).toEqual([
        { title: 'Hello', slug: 'hello', content: 'Body text', author_id: 1 },
      ])
    })

    test('the database enforces what the migrations declared: enum values, cascade and set-null', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      await migrate(db.connection, replay)
      await query(
        db.connection,
        `INSERT INTO "users" ("name", "email") VALUES ('Ada', 'ada@example.com')`,
      )
      await query(
        db.connection,
        `INSERT INTO "categories" ("name", "slug") VALUES ('News', 'news')`,
      )
      await expect(
        query(
          db.connection,
          `INSERT INTO "posts" ("title", "slug", "author_id", "status") VALUES ('x', 'x', 1, 'archived')`,
        ),
      ).rejects.toThrow()
      await query(
        db.connection,
        `INSERT INTO "posts" ("title", "slug", "author_id", "category_id") VALUES ('x', 'x', 1, 1)`,
      )
      await query(db.connection, `DELETE FROM "categories"`)
      expect(await query(db.connection, `SELECT "category_id" FROM "posts"`)).toEqual([
        { category_id: null },
      ])
      await query(db.connection, `DELETE FROM "users"`)
      expect(await count(db.connection, 'posts')).toBe(0)
    })

    test('the schema dump builds the same database as running every migration', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      for (const statement of createSchemaSql(replay.state, db.connection.grammar.dialect))
        await query(
          db.connection,
          isMysql(db.connection) ? statement.replaceAll('`', '"') : statement,
        )
      await noDrift(db, replay.state)
    })

    test('tenant tables get composite keys: no drift, and a row can never point at another tenant', async () => {
      const replay = tenantReplay()
      const db = await freshDb()
      await migrate(db.connection, replay)
      await noDrift(db, replay.state)
      const a = '0190a000-0000-7000-8000-00000000000a'
      const b = '0190a000-0000-7000-8000-00000000000b'
      await query(
        db.connection,
        `INSERT INTO "projects" ("tenant_id", "name") VALUES ('${a}', 'Alpha')`,
      )
      // The same name in another tenant is fine: uniques are per tenant.
      await query(
        db.connection,
        `INSERT INTO "projects" ("tenant_id", "name") VALUES ('${b}', 'Alpha')`,
      )
      await query(
        db.connection,
        `INSERT INTO "tasks" ("tenant_id", "project_id", "title") VALUES ('${a}', 1, 'ok')`,
      )
      await expect(
        query(
          db.connection,
          `INSERT INTO "tasks" ("tenant_id", "project_id", "title") VALUES ('${b}', 1, 'cross')`,
        ),
      ).rejects.toThrow()
      await expect(
        query(
          db.connection,
          `INSERT INTO "projects" ("tenant_id", "name") VALUES ('${a}', 'Alpha')`,
        ),
      ).rejects.toThrow()
      await reset(db.connection, replay)
      expect(await introspect(db.connection)).toEqual([])
    })

    test('drift check: a hand-made change is reported in plain words', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      await migrate(db.connection, replay)
      await query(db.connection, 'ALTER TABLE "posts" ADD COLUMN "sneaky" INTEGER NULL')
      await query(db.connection, 'CREATE INDEX "posts_title_index" ON "posts" ("title")')
      expect(
        schemaDrift(replay.state, await introspect(db.connection), db.connection.grammar.dialect),
      ).toEqual([
        'Column "posts.sneaky" is in the database but not in the migrations.',
        'Index "posts_title_index" on "posts" is in the database but not in the migrations.',
      ])
    })

    test('a ran migration whose file is gone, or whose operations changed, stops migrate and rollback', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      await migrate(db.connection, replay)
      await expect(migrate(db.connection, firstMigrations(replay, 3))).rejects.toMatchObject({
        code: 'migration_file_missing',
        message: expect.stringMatching(
          /says "2026_01_04_000000_create_categories_table" ran, but there is no such migration file/,
        ),
      })
      // Edit the last migration after it ran: rename to "labels" instead of "tags".
      const edited = await blogWith('2026_01_08_000000_noop', migration({ up() {}, down() {} }))
      const changed: Replay = {
        ...replay,
        migrations: replay.migrations.map((step, index) =>
          index === 6 ? { ...step, down: [] } : step,
        ),
      }
      await expect(migrate(db.connection, changed)).rejects.toMatchObject({
        code: 'migration_changed',
      })
      await expect(rollback(db.connection, changed)).rejects.toMatchObject({
        code: 'migration_changed',
      })
      expect((await migrationStatus(db.connection, changed)).drift).toEqual([
        { migration: '2026_01_07_000000_rename_labels_to_tags', kind: 'changed' },
      ])
      expect((await migrationStatus(db.connection, firstMigrations(replay, 6))).drift).toEqual([
        { migration: '2026_01_07_000000_rename_labels_to_tags', kind: 'missing' },
      ])
      expect(await count(db.connection, MIGRATIONS_TABLE)).toBe(7)
      // An unrelated new migration still runs when history is intact.
      expect((await migrate(db.connection, edited)).ran).toEqual(['2026_01_08_000000_noop'])
    })

    test('a NOT NULL column without a default is refused before anything runs when the table has rows', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      await migrate(db.connection, replay)
      await query(
        db.connection,
        `INSERT INTO "users" ("name", "email") VALUES ('Ada', 'ada@example.com')`,
      )
      // The recorder refuses this offline; a hand-built replay proves the runtime guard as well.
      const column = { name: 'nickname', kind: 'string', nullable: false, length: 50 } as const
      const users = replay.state.tables.find((t) => t.name === 'users')
      if (users === undefined) throw new Error('fixture has no users table')
      const after: SchemaState = {
        tables: replay.state.tables.map((t) =>
          t.name === 'users' ? { ...t, columns: [...t.columns, column] } : t,
        ),
      }
      const step: ReplayedStep = {
        name: '2026_01_09_000000_add_nickname_to_users_table',
        up: [{ type: 'alterTable', table: 'users', actions: [{ type: 'addColumn', column }] }],
        down: [
          {
            type: 'alterTable',
            table: 'users',
            actions: [{ type: 'dropColumn', name: 'nickname' }],
          },
        ],
        before: replay.state,
        after,
      }
      const bad: Replay = { migrations: [...replay.migrations, step], state: after }
      await expect(migrate(db.connection, bad)).rejects.toMatchObject({
        code: 'not_null_without_default',
        migration: step.name,
      })
      await noDrift(db, replay.state)
    })

    test('a table called "migrations" is refused: the name is reserved for bookkeeping', async () => {
      const db = await freshDb()
      const replay = replayMigrations([
        {
          name: '2026_03_01_000000_create_migrations_table',
          migration: migration({
            up: (schema) => schema.create('migrations', (t) => t.id()),
            down: (schema) => schema.drop('migrations'),
          }),
        },
      ])
      await expect(migrate(db.connection, replay)).rejects.toMatchObject({ code: 'reserved_table' })
    })

    test('reset, refresh and fresh', async () => {
      const replay = await replayApp(BLOG_ROOT)
      const db = await freshDb()
      expect((await reset(db.connection, replay)).rolledBack).toEqual([])
      await migrate(db.connection, replay)
      await query(
        db.connection,
        `INSERT INTO "users" ("name", "email") VALUES ('Ada', 'ada@example.com')`,
      )
      const refreshed = await refresh(db.connection, replay)
      expect(refreshed.rolledBack).toHaveLength(7)
      expect(refreshed.ran).toHaveLength(7)
      expect(await count(db.connection, 'users')).toBe(0)
      // fresh drops tables no migration knows about too.
      await query(db.connection, 'CREATE TABLE "stray" ("id" INTEGER NULL)')
      const dropped: string[] = []
      const result = await fresh(db.connection, replay, {
        onEvent: (event) => {
          if (event.type === 'dropped') dropped.push(event.table)
        },
      })
      expect(result.dropped).toContain('stray')
      expect(result.dropped).toContain(MIGRATIONS_TABLE)
      expect(dropped).toEqual(result.dropped)
      expect(result.ran).toHaveLength(7)
      await noDrift(db, replay.state)
      expect((await reset(db.connection, replay)).rolledBack).toHaveLength(7)
      await noDrift(db, EMPTY_SCHEMA)
      const emptied = await fresh(db.connection, { migrations: [], state: EMPTY_SCHEMA })
      expect(emptied.ran).toEqual([])
    })

    test('a failing migration: nothing behind on PostgreSQL/SQLite; MySQL/MariaDB report and resume', async () => {
      const db = await freshDb()
      const base = await replayApp(BLOG_ROOT)
      await migrate(db.connection, base)
      await query(
        db.connection,
        `INSERT INTO "users" ("name", "email") VALUES ('Ada', 'ada@example.com')`,
      )
      await query(
        db.connection,
        `INSERT INTO "posts" ("title", "slug", "author_id", "subtitle") VALUES ('a', 'a', 1, 'same')`,
      )
      await query(
        db.connection,
        `INSERT INTO "posts" ("title", "slug", "author_id", "subtitle") VALUES ('b', 'b', 1, 'same')`,
      )
      const name = '2026_01_08_000000_make_subtitles_unique'
      // Statement 1 (add column) works; statement 2 (unique index over duplicates) fails.
      const failing = await blogWith(
        name,
        migration({
          up: (schema) =>
            schema.table('posts', (t) => {
              t.string('code').nullable()
              t.unique('subtitle')
            }),
          down: (schema) =>
            schema.table('posts', (t) => {
              t.dropUnique('posts_subtitle_unique')
              t.dropColumn('code')
            }),
        }),
      )
      const error = await migrate(db.connection, failing).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(MigrationError)
      if (!(error instanceof MigrationError)) return
      expect(error.code).toBe('migration_failed')
      expect(error.migration).toBe(name)
      expect(error.failed).toMatch(/UNIQUE/i)
      if (!isMysql(db.connection)) {
        expect(error.applied).toEqual([])
        expect(error.hint).toMatch(/Nothing from this migration was applied/)
        await noDrift(db, base.state)
        expect((await ranMigrations(db.connection)).map((row) => row.migration)).not.toContain(name)
        return
      }
      // MySQL/MariaDB: the ADD COLUMN committed and is reported; the row records the progress.
      expect(error.applied).toHaveLength(1)
      expect(error.applied[0]).toMatch(/ADD COLUMN/i)
      expect(error.hint).toMatch(/resumes at the failed statement/)
      const status = await migrationStatus(db.connection, failing)
      expect(status.pending).toEqual([name])
      expect(status.drift).toEqual([{ migration: name, kind: 'partial' }])
      await expect(rollback(db.connection, failing)).rejects.toMatchObject({
        code: 'migration_partial',
      })
      // Fix the data, run again: it resumes at the index, not at the (already added) column.
      await query(db.connection, `UPDATE "posts" SET "subtitle" = 'other' WHERE "slug" = 'b'`)
      const events: string[] = []
      const resumed = await migrate(db.connection, failing, {
        onEvent: (event) => {
          if (event.type === 'resuming') events.push(`${event.migration}@${event.from}`)
        },
      })
      expect(resumed.ran).toEqual([name])
      expect(resumed.batch).toBe(2)
      expect(events).toEqual([`${name}@1`])
      await noDrift(db, failing.state)
      expect((await migrationStatus(db.connection, failing)).drift).toEqual([])
      await rollback(db.connection, failing)
      await noDrift(db, base.state)
    })

    test.skipIf(!engine.server)(
      'the lock: a second migrator waits, fails with a clear error, or skips with isolated',
      async () => {
        const replay = await replayApp(BLOG_ROOT)
        const db = await freshDb()
        const second = db.second?.()
        if (second === undefined) throw new Error('server engines have a second connection')
        let release: () => void = () => undefined
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        let entered: () => void = () => undefined
        const inside = new Promise<void>((resolve) => {
          entered = resolve
        })
        const holder = migrationLock(
          db.connection,
          { isolated: false, timeoutMs: 5000 },
          async () => {
            entered()
            await held
          },
        )
        await inside
        expect(await migrate(second, replay, { isolated: true })).toMatchObject({
          locked: true,
          ran: [],
        })
        expect(await rollback(second, replay, { isolated: true })).toMatchObject({ locked: true })
        expect(await reset(second, replay, { isolated: true })).toMatchObject({ locked: true })
        expect(await refresh(second, replay, { isolated: true })).toMatchObject({ locked: true })
        expect(await fresh(second, replay, { isolated: true })).toMatchObject({ locked: true })
        await expect(migrate(second, replay, { lockTimeoutMs: 300 })).rejects.toMatchObject({
          code: 'migration_locked',
          hint: expect.stringMatching(/node strut migrate/),
        })
        // Once released, a waiting migrator proceeds.
        const waiting = migrate(second, replay, { lockTimeoutMs: 20_000 })
        release()
        await holder
        expect((await waiting).ran).toHaveLength(7)
      },
    )
  })
})

describe('checksums', () => {
  test('stable across key order, different when operations differ', async () => {
    const replay = await replayApp(BLOG_ROOT)
    const step = replay.migrations[0]
    if (step === undefined) throw new Error('no migrations')
    const reordered = JSON.parse(JSON.stringify({ down: step.down, up: step.up })) as ReplayedStep
    expect(migrationChecksum(reordered)).toBe(migrationChecksum(step))
    expect(migrationChecksum({ up: step.up, down: [] })).not.toBe(migrationChecksum(step))
    expect(migrationChecksum(step)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('status on a database that never migrated creates nothing', async () => {
    const replay = await replayApp(BLOG_ROOT)
    const db = await ENGINES[0]?.open()
    if (db === undefined) throw new Error('no sqlite engine')
    try {
      const status = await migrationStatus(db.connection, replay)
      expect(status.pending).toHaveLength(7)
      expect(await introspect(db.connection)).toEqual([])
      expect((await rollback(db.connection, replay)).rolledBack).toEqual([])
    } finally {
      await db.close()
    }
  })
})
