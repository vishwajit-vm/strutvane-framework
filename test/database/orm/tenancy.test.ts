/**
 * Tenancy, attack-style. On MySQL and SQLite there is no row-level security: these tests prove the
 * ORM alone keeps tenants apart. Each test plays tenant A trying to reach tenant B's data through
 * one more door (list, find, search, counts, eager loading, writes, pivots, foreign keys, raw SQL,
 * scope bypasses, concurrency). On PostgreSQL an extra test shows RLS as the second layer.
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  CastError,
  type Connection,
  configureOrm,
  MassAssignmentError,
  ModelNotFoundError,
  runWithTenant,
  sql,
  TenantMismatchError,
  TenantRequiredError,
} from '../../../src/database/index.ts'
import type { UnsafeTenancyEvent } from '../../../src/database/orm/config.ts'
import { TenantScopeMissingError, unsafeRaw } from '../../../src/database/orm/tenant-scope.ts'
import { Label } from './fixtures/app/models/label.ts'
import { Post } from './fixtures/app/models/post.ts'
import { Project } from './fixtures/app/models/project.ts'
import { Task } from './fixtures/app/models/task.ts'
import { TeamProject } from './fixtures/app/models/team-project.ts'
import { User } from './fixtures/app/models/user.ts'
import { execute } from './support/ddl.ts'
import { type Engine, engines, engineTitle, useEngine } from './support/engines.ts'

const A = '0193a0b2-0000-7000-8000-00000000000a'
const B = '0193a0b2-0000-7000-8000-00000000000b'

/** Run `fn` as tenant A or B. */
const asA = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(A, fn)
const asB = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(B, fn)

/** Each tenant gets a project with a task and a label. Returns B's ids, the attacker's targets. */
async function seedTwoTenants(): Promise<{
  readonly projectB: Project
  readonly labelB: Label
  readonly taskB: Task
}> {
  await asA(async () => {
    const project = await Project.create({ name: 'Apollo', budget: '100.00' })
    await Task.create({ project_id: project.id, title: 'A task' })
    const label = await Label.create({ name: 'urgent' })
    await project.labels().attach([label.id])
  })
  return asB(async () => {
    const projectB = await Project.create({ name: 'Borealis secret', budget: '999.00' })
    const taskB = await Task.create({ project_id: projectB.id, title: 'B task' })
    // Same label name as A: unique per tenant, so no 409 tells either tenant about the other.
    const labelB = await Label.create({ name: 'urgent' })
    await projectB.labels().attach([labelB.id])
    return { projectB, labelB, taskB }
  })
}

function suite(engine: Engine): void {
  const connection = useEngine(engine)

  afterEach(() => {
    configureOrm({ tenancy: { column: 'tenant_id' }, onUnsafeTenancy: () => undefined })
  })

  test('no tenant, no data: reads and writes on tenant tables fail closed', async () => {
    await expect(Project.query().get()).rejects.toBeInstanceOf(TenantRequiredError)
    await expect(Project.create({ name: 'Orphan' })).rejects.toBeInstanceOf(TenantRequiredError)
    expect(() => runWithTenant('not-a-uuid', () => undefined)).toThrow(/not a valid tenant id/)
  })

  test('every read path returns only the active tenant rows', async () => {
    const { projectB, taskB } = await seedTwoTenants()
    await asA(async () => {
      expect((await Project.all()).map((project) => project.name)).toEqual(['Apollo'])
      expect(await Project.find(projectB.id)).toBeUndefined()
      await expect(Project.findOrFail(projectB.id)).rejects.toBeInstanceOf(ModelNotFoundError)
      expect(await Project.query().where('slug', projectB.slug).first()).toBeUndefined()
      expect(await Project.query().count()).toBe(1)
      expect((await Project.query().paginate(10)).total).toBe(1)
      expect((await Project.query().cursorPaginate(10)).data).toHaveLength(1)
      expect(await Project.query().search('secret', ['name']).count()).toBe(0)
      expect(await Project.query().filter('id', 'in', [projectB.id]).count()).toBe(0)
      // Child table reached by id guessing: it carries tenant_id, so it is scoped too (F-04).
      expect(await Task.query().filter('id', 'eq', taskB.id).count()).toBe(0)
      expect(await Task.query().filter('project_id', 'eq', projectB.id).count()).toBe(0)
      // Relations, counts and existence checks scope every tenant table they touch.
      const [apollo] = await Project.query()
        .with('tasks', 'labels')
        .withCount('tasks', 'labels')
        .get()
      expect(apollo?.tasks.map((task) => task.title)).toEqual(['A task'])
      expect(apollo?.labels.map((label) => label.name)).toEqual(['urgent'])
      expect([apollo?.tasks_count, apollo?.labels_count]).toEqual([1, 1])
      expect(
        await Project.query()
          .whereHas('tasks', (query) => query.where('title', 'B task'))
          .count(),
      ).toBe(0)
      expect(await Task.query().with('project').count()).toBe(1)
    })
  })

  test('OR conditions cannot escape the tenant condition (parentheses are added)', async () => {
    await seedTwoTenants()
    const leaked = await asA(() =>
      Project.query().where('name', 'Apollo').orWhere('name', 'Borealis secret').get(),
    )
    expect(leaked.map((project) => project.name)).toEqual(['Apollo'])
    const grouped = await asA(() =>
      Project.query()
        .where((query) => query.where('name', 'Borealis secret').orWhere('budget', '>', '0'))
        .get(),
    )
    expect(grouped.map((project) => project.name)).toEqual(['Apollo'])
  })

  test('the tenant column can never be written by a client or moved to another tenant', async () => {
    await seedTwoTenants()
    await asA(async () => {
      const smuggled: object = JSON.parse(`{"name": "Trojan", "tenant_id": "${B}"}`)
      await expect(Project.create(smuggled as { name: string })).rejects.toBeInstanceOf(
        MassAssignmentError,
      )
      await expect(Project.forceCreate(smuggled as { name: string })).rejects.toBeInstanceOf(
        MassAssignmentError,
      )
      const apollo = await Project.query().firstOrFail()
      apollo.setAttribute('tenant_id', B)
      await expect(apollo.save()).rejects.toBeInstanceOf(TenantMismatchError)
    })
    expect(await asB(() => Project.query().count())).toBe(1)
  })

  test('a model loaded as A cannot be saved or deleted as B', async () => {
    await seedTwoTenants()
    const apollo = await asA(() => Project.query().firstOrFail())
    apollo.name = 'Hijacked'
    await expect(asB(() => apollo.save())).rejects.toBeInstanceOf(ModelNotFoundError)
    await expect(asB(() => apollo.forceDelete())).rejects.toBeInstanceOf(ModelNotFoundError)
    expect((await asA(() => Project.query().firstOrFail())).name).toBe('Apollo')
  })

  test('composite foreign keys: a task cannot point at another tenant project, so cascades cannot cross', async () => {
    const { projectB } = await seedTwoTenants()
    // A row for (tenant A, B's project id) has no parent (A, B's id): the database refuses it.
    await expect(
      asA(() => Task.create({ project_id: projectB.id, title: 'Parasite' })),
    ).rejects.toThrow()
    // B deleting its project cascades only to B's tasks.
    await asB(async () => (await Project.findOrFail(projectB.id)).forceDelete())
    expect(await asA(() => Task.query().count())).toBe(1)
    expect(await asB(() => Task.query().count())).toBe(0)
  })

  test('pivot attach refuses ids the tenant cannot see (no cross-tenant links, no existence oracle)', async () => {
    const { labelB } = await seedTwoTenants()
    await asA(async () => {
      const apollo = await Project.query().firstOrFail()
      await expect(apollo.labels().attach([labelB.id])).rejects.toBeInstanceOf(ModelNotFoundError)
      await expect(apollo.labels().sync([labelB.id])).rejects.toBeInstanceOf(ModelNotFoundError)
      expect(await apollo.labels().count()).toBe(1)
    })
    expect(await asB(() => Label.query().count())).toBe(1)
  })

  test('attach, detach and sync check every id against the related key type before any SQL', async () => {
    await seedTwoTenants()
    await asA(async () => {
      const apollo = await Project.query().firstOrFail()
      const [label] = await apollo.labels().get()
      if (label === undefined) throw new Error('seed: Apollo has a label')
      // A JS caller (or a decoded body) can pass anything. On MySQL '1abc' = 1, so detaching
      // ['<id>abc'] used to remove the link to label <id>; objects and lists reached the driver.
      const hostile: readonly unknown[] = [
        `${label.id}abc`,
        { id: label.id },
        [label.id],
        true,
        1.5,
      ]
      const db = connection()
      let statements = 0
      const stop = db.onQuery(() => {
        statements += 1
      })
      try {
        for (const id of hostile) {
          const ids = [id] as unknown as readonly number[]
          await expect(apollo.labels().detach(ids), JSON.stringify(id)).rejects.toBeInstanceOf(
            CastError,
          )
          await expect(apollo.labels().attach(ids), JSON.stringify(id)).rejects.toBeInstanceOf(
            CastError,
          )
          await expect(apollo.labels().sync(ids), JSON.stringify(id)).rejects.toBeInstanceOf(
            CastError,
          )
        }
      } finally {
        stop()
      }
      expect(statements).toBe(0)
      expect((await apollo.labels().get()).map((linked) => linked.id)).toEqual([label.id])
      // Digits from a URL are a real id, as everywhere else.
      expect(await apollo.labels().detach([String(label.id)] as unknown as readonly number[])).toBe(
        1,
      )
    })
  })

  test('the SQL-tree check refuses a tenant join without its tenant condition (planted bug)', async () => {
    await seedTwoTenants()
    // Simulate an ORM bug: a join to the tenant pivot that "forgot" its scope.
    const buggy = Label.query()
    buggy.addJoin({
      table: 'project_label',
      alias: 'project_label',
      left: { alias: 'labels', column: 'id' },
      right: { alias: 'project_label', column: 'label_id' },
    })
    await expect(asA(() => buggy.get())).rejects.toBeInstanceOf(TenantScopeMissingError)
  })

  test('raw SQL that names a tenant table is refused in a tenant context unless marked unsafe (audited)', async () => {
    await seedTwoTenants()
    const db: Connection = connection()
    await expect(
      asA(() => db.run(sql`SELECT * FROM ${sql.id('projects')}`)),
    ).rejects.toBeInstanceOf(TenantScopeMissingError)
    await expect(asA(() => db.run(sql`SELECT COUNT(*) AS n FROM PROJECTS`))).rejects.toBeInstanceOf(
      TenantScopeMissingError,
    )
    const events: UnsafeTenancyEvent[] = []
    configureOrm({ onUnsafeTenancy: (event) => events.push(event) })
    const { rows } = await asA(() =>
      db.run(unsafeRaw('usage report', sql`SELECT COUNT(*) AS n FROM ${sql.id('projects')}`)),
    )
    expect(Number(rows[0]?.['n'])).toBe(2)
    expect(events).toEqual([{ kind: 'raw', tables: ['projects'], reason: 'usage report' }])
    // Global tables are fine; and outside a request (migrations, jobs) raw SQL is allowed.
    await asA(() => db.run(sql`SELECT COUNT(*) AS n FROM ${sql.id('users')}`))
    await db.run(sql`SELECT COUNT(*) AS n FROM ${sql.id('projects')}`)
  })

  test('raw conditions inside a builder query are guarded like hand-written SQL (no tenant oracle through whereRaw)', async () => {
    await seedTwoTenants()
    const author = await User.forceCreate({
      name: 'Ann',
      email: 'ann@example.test',
      is_admin: false,
    })
    await Post.forceCreate({ title: 'Public', author_id: author.id })
    // A global root table with a raw EXISTS over another tenant's rows: before the fix the builder
    // marked the whole statement as checked, so this answered "does B have a project named X?".
    const oracle = (): Promise<number> =>
      asA(() =>
        Post.query()
          .whereRaw(
            sql`EXISTS (SELECT 1 FROM ${sql.id('projects')} WHERE ${sql.id('name')} = ${'Borealis secret'})`,
          )
          .count(),
      )
    await expect(oracle()).rejects.toBeInstanceOf(TenantScopeMissingError)
    // Plain text mentions and other spellings of the name are refused too (SQLite and MySQL on
    // Windows/macOS treat table names case-insensitively).
    await expect(
      asA(() => Post.query().whereRaw(sql`EXISTS (SELECT 1 FROM tasks)`).count()),
    ).rejects.toBeInstanceOf(TenantScopeMissingError)
    await expect(
      asA(() =>
        Post.query()
          .whereRaw(sql`EXISTS (SELECT 1 FROM ${sql.id('PROJECTS')})`)
          .count(),
      ),
    ).rejects.toBeInstanceOf(TenantScopeMissingError)
    await expect(
      asA(() => connection().run(sql`SELECT COUNT(*) AS n FROM ${sql.id('Projects')}`)),
    ).rejects.toBeInstanceOf(TenantScopeMissingError)
    // Nested: a raw condition inside a whereHas constraint and inside a where group.
    await expect(
      asA(() =>
        Project.query()
          .whereHas('tasks', (query) =>
            query.whereRaw(sql`EXISTS (SELECT 1 FROM ${sql.id('labels')})`),
          )
          .count(),
      ),
    ).rejects.toBeInstanceOf(TenantScopeMissingError)
    await expect(
      asA(() =>
        Post.query()
          .where((query) => query.whereRaw(sql`EXISTS (SELECT 1 FROM ${sql.id('labels')})`))
          .count(),
      ),
    ).rejects.toBeInstanceOf(TenantScopeMissingError)
    // The ORM's own text conditions on a tenant table keep working, and so does an audited bypass.
    expect(
      await asA(() =>
        Project.query().search('apollo', ['name']).filter('name', 'startsWith', 'Ap').count(),
      ),
    ).toBe(1)
    const events: UnsafeTenancyEvent[] = []
    configureOrm({ onUnsafeTenancy: (event) => events.push(event) })
    const audited = await asA(() =>
      Post.query()
        .whereRaw(
          unsafeRaw(
            'cross-tenant report',
            sql`EXISTS (SELECT 1 FROM ${sql.id('projects')} WHERE ${sql.id('name')} = ${'Borealis secret'})`,
          ),
        )
        .count(),
    )
    expect(audited).toBe(1)
    expect(events).toEqual([{ kind: 'raw', tables: ['projects'], reason: 'cross-tenant report' }])
  })

  test('unsafeWithoutTenancy needs a reason, is audited, and is a real bypass without RLS', async () => {
    await seedTwoTenants()
    const events: UnsafeTenancyEvent[] = []
    configureOrm({ onUnsafeTenancy: (event) => events.push(event) })
    expect(() => Project.query().unsafeWithoutTenancy('')).toThrow(/need a short reason/)
    const all = await asA(() => Project.query().unsafeWithoutTenancy('cross-tenant report').count())
    expect(events).toEqual([{ kind: 'query', tables: ['projects'], reason: 'cross-tenant report' }])
    // MySQL and SQLite have no database backstop (2 rows); PostgreSQL has RLS, tested below.
    expect(all).toBe(2)
  })

  test('the tenant column is configuration, and unknown tables fail closed (F-04)', async () => {
    // With the default column, team_projects has neither tenant_id nor `global`: refused.
    await expect(asA(() => TeamProject.query().get())).rejects.toBeInstanceOf(
      TenantScopeMissingError,
    )
    await expect(asA(() => TeamProject.create({ name: 'x' }))).rejects.toBeInstanceOf(
      TenantScopeMissingError,
    )
    // Teams: the canonical column is team_id. Now team_projects is scoped, and the tenant_id
    // tables are the ones refused, because they do not carry the configured key.
    configureOrm({ tenancy: { column: 'team_id' } })
    await asA(() => TeamProject.create({ name: 'Team A plan' }))
    await asB(() => TeamProject.create({ name: 'Team B plan' }))
    expect((await asA(() => TeamProject.all())).map((row) => row.name)).toEqual(['Team A plan'])
    await expect(asA(() => Project.query().get())).rejects.toBeInstanceOf(TenantScopeMissingError)
  })

  test('concurrent requests never see each other: 200 interleaved operations over two tenants', async () => {
    await seedTwoTenants()
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) => {
        const tenant = index % 2 === 0 ? A : B
        return runWithTenant(tenant, async () => {
          await new Promise((resolve) => setTimeout(resolve, index % 7))
          const names = (await Project.all()).map((project) => project.name)
          return { tenant, names }
        })
      }),
    )
    for (const { tenant, names } of results)
      expect(names).toEqual([tenant === A ? 'Apollo' : 'Borealis secret'])
  })

  if (engine.dialect === 'postgres') {
    test('PostgreSQL: row-level security still isolates when the app scope is bypassed', async () => {
      await seedTwoTenants()
      const db = connection()
      // ADR-0007: RESTRICTIVE policy with NULLIF, FORCE RLS, and a runtime role that is not the owner.
      for (const statement of [
        'ALTER TABLE projects ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE projects FORCE ROW LEVEL SECURITY',
        "CREATE POLICY tenant_isolation ON projects AS RESTRICTIVE FOR ALL USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)",
        'CREATE POLICY tenant_access ON projects AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)',
        'CREATE ROLE spike11_app NOLOGIN',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO spike11_app',
        'SET ROLE spike11_app',
      ]) {
        await execute(db, statement)
      }
      try {
        const viaBypass = await asA(() =>
          Project.query().unsafeWithoutTenancy('RLS backstop check').count(),
        )
        expect(viaBypass).toBe(1)
        // Outside any tenant the setting is unset ('' → NULL): zero rows, not all rows.
        expect(await Project.query().unsafeWithoutTenancy('no tenant at all').count()).toBe(0)
      } finally {
        await execute(db, 'RESET ROLE')
        await execute(db, 'ALTER TABLE projects NO FORCE ROW LEVEL SECURITY')
        await execute(db, 'ALTER TABLE projects DISABLE ROW LEVEL SECURITY')
      }
    })
  }
}

describe.each(engines)('tenancy on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => suite(engine))
})
