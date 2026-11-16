/**
 * Models: create/update/delete, mass assignment, casts, timestamps, soft deletes, slugs, keys
 * and serialization, on MySQL, PostgreSQL and SQLite.
 */
import { describe, expect, test, vi } from 'vitest'
import { CastError, MassAssignmentError, Model, ModelNotFoundError, OrmUsageError, runWithTenant, sql } from '#orm'
import { uuidv7 } from '#orm/orm/keys'
import { unsafeRaw } from '#orm/orm/tenant-scope'
import { Post } from '#app/models/post'
import { Project } from '#app/models/project'
import { User } from '#app/models/user'
import { engines, engineTitle, useEngine } from './support/engines.ts'
import { makePost, makeUser } from './support/seed.ts'

const TENANT = '0193a0b2-7c1e-7d4f-8a9b-0c1d2e3f4a5b'

/** Scopes named like Promise members: `await Tag.query()` would call them instead of running the query. */
class ThenScope extends Model('tags', { fillable: ['name'] }) {
  static readonly scopes = { then: (query: unknown) => query }
}
class CatchScope extends Model('tags', { fillable: ['name'] }) {
  static readonly scopes = { catch: (query: unknown) => query }
}
class FinallyScope extends Model('tags', { fillable: ['name'] }) {
  static readonly scopes = { finally: (query: unknown) => query }
}

/** The posts table without a model cast on `meta`: any JSON value may be stored there. */
class LoosePost extends Model('posts', { fillable: ['title', 'meta'] }) {}

/** What a JS caller (or a cast in TS) does: hand unvalidated input straight to create(). */
function asCreateInput(body: object): { name: string; email: string } {
  return body as { name: string; email: string }
}

describe.each(engines)('models on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => {
    const connection = useEngine(engine)

    test('create fills database defaults, keys and timestamps, and reads them back', async () => {
      const ada = await makeUser('Ada')
      expect(ada.id).toBeTypeOf('number')
      expect(ada.is_admin).toBe(false) // database default, cast from 0 on MySQL/SQLite
      expect(ada.created_at).toBeInstanceOf(Date)
      expect(ada.updated_at?.getTime()).toBe(ada.created_at?.getTime())
      expect(ada.isPersisted()).toBe(true)
    })

    test('a custom cast (mutator) normalises on write', async () => {
      const user = await User.create({ name: 'Grace', email: '  Grace@Example.TEST ' })
      expect(user.email).toBe('grace@example.test')
    })

    test('update writes only dirty columns and bumps updated_at', async () => {
      const ada = await makeUser('Ada')
      const post = await makePost(ada, 'First')
      const before = post.updated_at?.getTime() ?? 0
      await new Promise((resolve) => setTimeout(resolve, 5))
      post.title = 'First, edited'
      expect(post.getDirty()).toEqual({ title: 'First, edited' })
      await post.save()
      expect(post.isDirty()).toBe(false)
      expect(post.updated_at?.getTime()).toBeGreaterThan(before)
      expect((await Post.findOrFail(post.id)).title).toBe('First, edited')
    })

    test('casts round-trip: boolean, enum, date, json, timestamp, decimal', async () => {
      const ada = await makeUser('Ada')
      const post = await makePost(ada, 'Typed')
      post.fill({ status: 'published', published_on: '2026-11-14', meta: { tags: ['orm'], pinned: true } })
      await post.save()
      const fresh = await Post.findOrFail(post.id)
      expect(fresh.status).toBe('published')
      expect(fresh.published_on).toBe('2026-11-14')
      expect(fresh.meta).toEqual({ tags: ['orm'], pinned: true })
      expect(fresh.created_at).toBeInstanceOf(Date)
      await runWithTenant(TENANT, async () => {
        const project = await Project.create({ name: 'Budgeted', budget: 10.5 })
        expect(project.budget).toBe('10.50') // exact decimal string on every engine
      })
    })

    test('a JSON column round-trips every JSON value, top-level strings included', async () => {
      const ada = await makeUser('Ada')
      // mysql2 already parses JSON columns, so a stored JSON string arrives as a plain JS string;
      // parsing it again crashed ("hello") or changed its type ("123" became 123) on MySQL only.
      for (const meta of ['hello', '123', 'null', '', 42, true, [1, 'a'], { a: 'x' }]) {
        const post = await LoosePost.forceCreate({ title: `json ${JSON.stringify(meta)}`, author_id: ada.id, meta })
        const fresh = await LoosePost.findOrFail(post.id)
        expect(fresh.meta, JSON.stringify(meta)).toEqual(meta)
      }
      expect((await LoosePost.query().get()).length).toBe(8) // a list read never trips over one row
    })

    test('decimals given as JS numbers are checked, never silently rounded to the column scale', async () => {
      await runWithTenant(TENANT, async () => {
        // 10.555 used to be stored as 10.55 or 10.56 (toFixed on a float), and 0.1 + 0.2 as 0.30:
        // money changed without an error. Now they are refused like the string "10.555" already was.
        for (const budget of [10.555, 0.1 + 0.2, 1e21, 1e-7, Number.NaN, Number.POSITIVE_INFINITY]) {
          await expect(Project.create({ name: `Budget ${String(budget)}`, budget }), String(budget)).rejects.toBeInstanceOf(CastError)
        }
        await expect(Project.create({ name: 'Too precise', budget: '10.555' })).rejects.toBeInstanceOf(CastError)
        // Exact values keep working, as numbers and as strings.
        expect((await Project.create({ name: 'Whole', budget: 12 })).budget).toBe('12.00')
        expect((await Project.create({ name: 'Cents', budget: 10.25 })).budget).toBe('10.25')
        expect((await Project.create({ name: 'Negative', budget: -0.5 })).budget).toBe('-0.50')
        expect((await Project.create({ name: 'Text', budget: '999.90' })).budget).toBe('999.90')
      })
    })

    test('dates and timestamps are validated the same way on every engine (no time-zone guessing)', async () => {
      const ada = await makeUser('Ada')
      const post = await makePost(ada, 'Dated')
      // Calendar dates that do not exist: SQLite stored them, PostgreSQL and MySQL failed with a
      // database error (a 500), and new Date() would have rolled 2026-02-30 over to March 2.
      for (const day of ['2026-02-30', '2026-13-01', '0999-12-31']) {
        post.fill({ published_on: day })
        await expect(post.save(), day).rejects.toBeInstanceOf(CastError)
        await post.refresh()
      }
      // Timestamps need an explicit zone: '2026-11-14T10:00:00' meant 10:00 in the *server's* zone.
      for (const moment of ['2026-11-14T10:00:00', '2026-11-14 10:00:00', 'Nov 14 2026', '1', '2026-11-14T24:00:00Z', '+010000-01-01T00:00:00Z']) {
        expect(() => Post.query().filter('created_at', 'gt', moment), moment).toThrow(CastError)
      }
      expect(() => Post.query().where('created_at', '>', new Date('+010000-01-01T00:00:00Z'))).toThrow(CastError)
      // Offsets are honoured and stored as UTC; a date-only string means UTC midnight.
      // What a JS caller (or a decoded JSON body) can hand over: a string, not a Date.
      ;(post as unknown as { setAttribute(column: string, value: unknown): unknown }).setAttribute('created_at', '2026-11-14T10:00:00+05:30')
      await post.save()
      expect((await Post.findOrFail(post.id)).created_at?.toISOString()).toBe('2026-11-14T04:30:00.000Z')
      expect(await Post.query().filter('created_at', 'gte', '2026-11-14').filter('created_at', 'lt', '2026-11-14T04:30:00.001Z').count()).toBe(1)
    })

    test('malformed Unicode (a lone surrogate) is refused, never silently replaced', async () => {
      // A JS string can hold half of a surrogate pair. Encoded to UTF-8 by the drivers it became
      // U+FFFD on some engines and an error on others: the stored text differed from what was sent.
      const lone = 'Ada \uD800 Lovelace'
      await expect(User.create({ name: lone, email: 'lone@example.test' })).rejects.toBeInstanceOf(CastError)
      await expect(User.create({ name: 'Trail \uDC00', email: 'trail@example.test' })).rejects.toBeInstanceOf(CastError)
      expect(() => User.query().filter('name', 'eq', lone)).toThrow(CastError)
      expect(() => User.query().search(lone, ['name'])).toThrow(CastError)
      expect(() => User.query().filter('name', 'contains', '\uDBFF')).toThrow(CastError)
      expect(() => User.query().filter('name', 'startsWith', '\uDBFF')).toThrow(CastError)
      // Real pairs (emoji, astral characters) are fine and round-trip exactly.
      const ok = await User.create({ name: 'Ada \u{1F600} \u{20BB7}', email: 'ok@example.test' })
      expect((await User.findOrFail(ok.id)).name).toBe('Ada \u{1F600} \u{20BB7}')
    })

    test('enum and length violations fail the same way on every engine', async () => {
      const ada = await makeUser('Ada')
      const post = await makePost(ada, 'Strict')
      // A JS caller (no types) sending a value outside the enum:
      expect(() => post.fill(JSON.parse('{"status":"archived"}'))).not.toThrow()
      await expect(post.save()).rejects.toBeInstanceOf(CastError)
      // SQLite ignores VARCHAR(200); the cast enforces it so all engines agree.
      const long = Post.make()
      long.fill({ title: 'x'.repeat(201) })
      await expect(long.save()).rejects.toThrow(/longer than 200 characters/)
    })

    test('mass assignment refuses unknown, guarded and system columns, with friendly messages', async () => {
      // Request bodies as they arrive: parsed JSON, untyped. JSON.parse makes "__proto__" an own key.
      const attempts: readonly [string, RegExp][] = [
        ['"is_admin": true', /can't be mass-assigned on "users"/],
        ['"nmae": "typo"', /Did you mean "name"\?/],
        ['"id": 99', /managed by Strutvane/],
        ['"__proto__": {"is_admin": true}', /has no column "__proto__"/],
      ]
      for (const [extra, message] of attempts) {
        const body: object = JSON.parse(`{"name": "Eve", "email": "eve@example.test", ${extra}}`)
        await expect(User.create(asCreateInput(body))).rejects.toThrow(message)
      }
      await expect(User.create(asCreateInput(JSON.parse('{"name": "Eve", "email": "e@example.test", "is_admin": true}')))).rejects.toBeInstanceOf(MassAssignmentError)
      expect(await User.query().count()).toBe(0)
    })

    test('forceCreate is for trusted code: any real column, still never system columns', async () => {
      const ada = await makeUser('Ada')
      const post = await Post.forceCreate({ title: 'Seeded', author_id: ada.id, view_count: 7 })
      expect(post.view_count).toBe(7)
      await expect(Post.forceCreate(Object.assign({ title: 'x', author_id: ada.id }, JSON.parse('{"deleted_at": null}')))).rejects.toThrow(/managed by Strutvane/)
    })

    test('soft deletes hide rows; withTrashed, onlyTrashed, restore and forceDelete work', async () => {
      const ada = await makeUser('Ada')
      const post = await makePost(ada, 'Ephemeral')
      await post.delete()
      expect(post.trashed()).toBe(true)
      expect(await Post.find(post.id)).toBeUndefined()
      expect(await Post.withTrashed().find(post.id)).toBeDefined()
      expect((await Post.onlyTrashed().get()).map((row) => row.id)).toEqual([post.id])
      await post.restore()
      expect(await Post.find(post.id)).toBeDefined()
      await post.forceDelete()
      expect(await Post.withTrashed().find(post.id)).toBeUndefined()
    })

    test('slugs are generated from the source column and kept unique', async () => {
      const ada = await makeUser('Ada')
      const first = await makePost(ada, 'Crème Brûlée: 100% Better!')
      const second = await makePost(ada, 'Crème brûlée 100% better')
      const third = await makePost(ada, 'Crème Brûlée — 100% better')
      expect(first.slug).toBe('creme-brulee-100-better')
      // Decision #49 (2026-11-15): sequential -2, -3, like Laravel's packages, guarded by the
      // unique index plus a retry. Lookups stay within the tenant, so they count only rows the
      // tenant may already see.
      expect([second.slug, third.slug]).toEqual(['creme-brulee-100-better-2', 'creme-brulee-100-better-3'])
      // A gap is reused: the lowest free number wins.
      await second.forceDelete()
      expect((await makePost(ada, 'Crème brûlée 100% better')).slug).toBe('creme-brulee-100-better-2')
      // "%" and "_" in titles must not act as LIKE wildcards when looking for taken slugs.
      const underscore = await makePost(ada, 'a_b')
      const lookalike = await makePost(ada, 'axb')
      expect([underscore.slug, lookalike.slug]).toEqual(['a-b', 'axb'])
    })

    test('slugs are unique per tenant when the unique index includes tenant_id', async () => {
      const other = '0193a0b2-7c1e-7d4f-8a9b-000000000002'
      const a = await runWithTenant(TENANT, () => Project.create({ name: 'Launch' }))
      const b = await runWithTenant(other, () => Project.create({ name: 'Launch' }))
      const c = await runWithTenant(TENANT, () => Project.create({ name: 'Launch' }))
      // Tenant B gets "launch" too: another tenant's slug is invisible and never changes yours.
      expect([a.slug, b.slug]).toEqual(['launch', 'launch'])
      expect(c.slug).toBe('launch-2')
    })

    test('a slug the lookup cannot see (a concurrent insert, a snapshot) still ends up free on retry', async () => {
      await runWithTenant(TENANT, () => Project.create({ name: 'Launch' }))
      // Make the "taken slugs" lookup blind, as it is for a row committed by another transaction
      // after this one's snapshot (MySQL REPEATABLE READ) or not committed yet. The unique index
      // still sees the row. Before the fix every retry picked the same "launch" and all 5 failed.
      const db = connection()
      const run = db.run.bind(db)
      const blind = vi.spyOn(db, 'run').mockImplementation(async (fragment, options) =>
        db.grammar.render(fragment).sql.includes(' AS slug FROM ') ? { rows: [], rowsAffected: 0 } : run(fragment, options),
      )
      try {
        const second = await runWithTenant(TENANT, () => Project.create({ name: 'Launch' }))
        expect(second.slug).toBe('launch-2')
      } finally {
        blind.mockRestore()
      }
    })

    if (engine.name === 'mysql' || engine.name === 'mariadb') {
      test('MySQL and MariaDB: a slug committed by another connection after our snapshot is not retried forever', async () => {
        const other = await engine.connect()
        try {
          const created = await runWithTenant(TENANT, () =>
            connection().transaction(async () => {
              // The first read fixes this transaction's REPEATABLE READ snapshot.
              expect(await Project.query().count()).toBe(0)
              // Another request commits "launch" for the same tenant on its own connection.
              const columns = sql`${sql.id('id')}, ${sql.id('tenant_id')}, ${sql.id('name')}, ${sql.id('slug')}, ${sql.id('budget')}`
              await other.run(unsafeRaw('test: a concurrent request', sql`INSERT INTO ${sql.id('projects')} (${columns}) VALUES (${uuidv7()}, ${TENANT}, ${'Launch'}, ${'launch'}, ${'0.00'})`))
              // Our lookup still reads the old snapshot, but the unique index sees the new row.
              return Project.create({ name: 'Launch' })
            }),
          )
          expect(created.slug).toBe('launch-2')
        } finally {
          await other.close()
        }
      })
    }

    test('a retry after a conflict moves on to the next number, never the one that just failed', async () => {
      // Two rows the lookup can't see: "launch" and "launch-2". Each conflict marks the slug it
      // tried as taken, so the retries go launch → launch-2 → launch-3.
      await runWithTenant(TENANT, async () => {
        await Project.create({ name: 'Launch' })
        await Project.create({ name: 'Launch' })
      })
      const db = connection()
      const run = db.run.bind(db)
      const blind = vi.spyOn(db, 'run').mockImplementation(async (fragment, options) =>
        db.grammar.render(fragment).sql.includes(' AS slug FROM ') ? { rows: [], rowsAffected: 0 } : run(fragment, options),
      )
      try {
        expect((await runWithTenant(TENANT, () => Project.create({ name: 'Launch' }))).slug).toBe('launch-3')
      } finally {
        blind.mockRestore()
      }
    })

    test('scopes named then, catch or finally are refused when the model is first used', () => {
      // A scope is installed as a method on the query builder. Named `then`, it made every query
      // thenable: `await ThenScope.query()` called the scope instead of running SQL.
      for (const model of [ThenScope, CatchScope, FinallyScope]) {
        expect(() => model.query(), model.name).toThrow(OrmUsageError)
        expect(() => model.query(), model.name).toThrow(/clashes with/)
      }
    })

    test('UUID keys are generated as UUIDv7 and are time-ordered', async () => {
      const projects = await runWithTenant(TENANT, async () => [await Project.create({ name: 'One' }), await Project.create({ name: 'Two' })])
      for (const project of projects) expect(project.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      const [one, two] = projects
      expect(one !== undefined && two !== undefined && one.id < two.id).toBe(true)
    })

    test('toJSON leaves hidden columns out and writes dates as ISO strings', async () => {
      const ada = await makeUser('Ada')
      const json = ada.toJSON()
      expect(json).not.toHaveProperty('password')
      expect(json.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(JSON.parse(JSON.stringify(ada))).not.toHaveProperty('password')
    })

    test('findOrFail and saving a vanished row are "not found", not crashes', async () => {
      await expect(Post.findOrFail(424242)).rejects.toBeInstanceOf(ModelNotFoundError)
      const ada = await makeUser('Ada')
      const post = await makePost(ada, 'Gone')
      await Post.query().findOrFail(post.id).then((copy) => copy.forceDelete())
      post.title = 'Too late'
      await expect(post.save()).rejects.toBeInstanceOf(ModelNotFoundError)
    })

    test('a model whose primary key changes is refused', async () => {
      const ada = await makeUser('Ada')
      ada.id = ada.id + 1000
      await expect(ada.save()).rejects.toBeInstanceOf(OrmUsageError)
    })
  })
})
