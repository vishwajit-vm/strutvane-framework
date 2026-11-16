/**
 * Transactions: commit, rollback, nested savepoints, and isolation between concurrent callers
 * (the transaction travels with the async call chain, not with a shared connection).
 */
import { describe, expect, test } from 'vitest'
import { runWithTenant, TenantMismatchError, transaction } from '#orm'
import { Project } from '#app/models/project'
import { Tag } from '#app/models/tag'
import { execute } from './support/ddl.ts'
import { type Engine, engines, engineTitle, useEngine } from './support/engines.ts'
import { makeTag } from './support/seed.ts'

const names = async (): Promise<string[]> => (await Tag.query().orderBy('name').get()).map((tag) => tag.name)

function suite(engine: Engine): void {
  const connection = useEngine(engine)

  test('commit keeps everything; a thrown error rolls everything back', async () => {
    await transaction(async () => {
      await makeTag('kept-1')
      await makeTag('kept-2')
    })
    await expect(
      transaction(async () => {
        await makeTag('lost')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await names()).toEqual(['kept-1', 'kept-2'])
  })

  test('nested transactions are savepoints: an inner failure undoes only the inner work', async () => {
    await transaction(async () => {
      await makeTag('outer')
      await expect(
        transaction(async () => {
          await makeTag('inner-lost')
          throw new Error('inner failure')
        }),
      ).rejects.toThrow('inner failure')
      await transaction(async () => {
        await makeTag('inner-kept')
        await transaction(async () => {
          await makeTag('deepest')
        })
      })
    })
    expect(await names()).toEqual(['deepest', 'inner-kept', 'outer'])
  })

  test('an outer failure rolls back released savepoints too', async () => {
    await expect(
      transaction(async () => {
        await transaction(() => makeTag('inner'))
        throw new Error('outer failure')
      }),
    ).rejects.toThrow('outer failure')
    expect(await names()).toEqual([])
  })

  test('code inside a transaction sees its own writes; others never see uncommitted ones', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = transaction(async () => {
      await makeTag('pending')
      expect(await names()).toEqual(['pending'])
      await gate
    })
    // A concurrent reader outside the transaction: on single-connection engines it waits for the
    // commit (the lock); on MySQL it reads committed data only. Either way: never "pending" early.
    const reader = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const seen = await names()
      return seen
    })()
    // Pooled engines: commit only after the reader has read, so the check doesn't depend on timing
    // (under load the reader used to start after a 60 ms commit and saw 'pending'). Single-connection
    // engines: the reader waits for the lock, so the commit has to come first.
    const pooled = engine.name === 'mysql' || engine.name === 'mariadb'
    if (pooled) void reader.finally(release)
    else setTimeout(release, 60)
    const [seenByReader] = await Promise.all([reader, writer])
    // MySQL and MariaDB (a pool): the reader runs on another connection and sees only committed data.
    // SQLite/PGlite (one connection): the reader waits for the lock, so it reads after the commit.
    expect(seenByReader).toEqual(pooled ? [] : ['pending'])
    expect(await names()).toEqual(['pending'])
  })

  test('parallel nested transactions on one connection are refused with a clear message', async () => {
    await expect(
      transaction(async () => {
        await Promise.all([transaction(() => makeTag('a')), transaction(() => makeTag('b'))])
      }),
    ).rejects.toThrow(/one after another/)
    expect(await names()).toEqual([])
  })

  test('slug retries inside a transaction use savepoints, so the outer transaction survives', async () => {
    await runWithTenant('0193a0b2-0000-7000-8000-0000000000aa', () =>
      transaction(async () => {
        const first = await Project.create({ name: 'Same' })
        const second = await Project.create({ name: 'Same' })
        expect(first.slug).not.toBe(second.slug)
      }),
    )
    expect(await runWithTenant('0193a0b2-0000-7000-8000-0000000000aa', () => Project.query().count())).toBe(2)
  })

  if (engine.name === 'postgres') {
    test('PostgreSQL: one transaction can only ever belong to one tenant', async () => {
      const db = connection()
      await expect(
        db.transaction(async () => {
          await runWithTenant('0193a0b2-0000-7000-8000-0000000000aa', () => Project.query().count())
          await runWithTenant('0193a0b2-0000-7000-8000-0000000000bb', () => Project.query().count())
        }),
      ).rejects.toBeInstanceOf(TenantMismatchError)
    })

    test('PostgreSQL: a rolled-back savepoint that set the tenant does not leave RLS without one', async () => {
      const db = connection()
      const tenant = '0193a0b2-0000-7000-8000-0000000000aa'
      await runWithTenant(tenant, () => Project.create({ name: 'Kept' }))
      // ADR-0007 RLS on projects, as a non-owner role, so the database checks app.tenant_id too.
      for (const statement of [
        'ALTER TABLE projects ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE projects FORCE ROW LEVEL SECURITY',
        "CREATE POLICY savepoint_isolation ON projects AS RESTRICTIVE FOR ALL USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)",
        'CREATE POLICY savepoint_access ON projects AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)',
        'CREATE ROLE spike11_savepoint NOLOGIN',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO spike11_savepoint',
        'SET ROLE spike11_savepoint',
      ]) {
        await execute(db, statement)
      }
      try {
        const outcome = await runWithTenant(tenant, () =>
          db.transaction(async () => {
            // The first tenant statement runs inside this savepoint, so ROLLBACK TO SAVEPOINT also
            // undoes its set_config. Before the fix the connection still believed the tenant was set,
            // and every later statement ran with no app.tenant_id: 0 rows, and inserts refused by RLS.
            await db
              .transaction(async () => {
                await Project.create({ name: 'Doomed' })
                throw new Error('undo')
              })
              .catch(() => undefined)
            const visible = await Project.query().count()
            const after = await Project.create({ name: 'After' })
            return [visible, after.name]
          }),
        )
        expect(outcome).toEqual([1, 'After'])
      } finally {
        await execute(db, 'RESET ROLE')
        await execute(db, 'DROP POLICY savepoint_isolation ON projects')
        await execute(db, 'DROP POLICY savepoint_access ON projects')
        await execute(db, 'ALTER TABLE projects NO FORCE ROW LEVEL SECURITY')
        await execute(db, 'ALTER TABLE projects DISABLE ROW LEVEL SECURITY')
      }
    })
  }
}

describe.each(engines)('transactions on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => suite(engine))
})
