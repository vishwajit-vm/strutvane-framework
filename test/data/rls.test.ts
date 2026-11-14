/**
 * Row-level security on real Postgres (PGlite): the database itself enforces tenant isolation,
 * independently of the repository's WHERE clause (ADR-0007). Runs as a non-owner,
 * non-BYPASSRLS role, as production must.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planMigration } from '../../src/migrations/planner.ts'
import { tenancyAudit } from '../../src/migrations/rls.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { models } from '../helpers/models.ts'
import { type Fixture, setupDatabase, TENANT_A, TENANT_B } from '../helpers/setup.ts'

describe('tenant isolation enforced by Postgres RLS', () => {
  let fx: Fixture
  beforeEach(async () => {
    fx = await setupDatabase('postgres', models)
    // Owner audit before switching role: the superuser bypasses RLS and the audit says so.
    expect(await tenancyAudit(fx.db)).toEqual([{ table: '*', problem: 'role-bypasses-rls' }])
    await fx.db.execute('CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS')
    await fx.db.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON customers, invoices TO app_user')
    await fx.db.execute('SET ROLE app_user')
  })
  afterEach(async () => {
    await fx.db.close()
  })

  it('the runtime role passes the tenancy audit', async () => {
    expect(await tenancyAudit(fx.db)).toEqual([])
  })

  it('an unscoped query sees zero rows (fails closed, no error on an unset tenant)', async () => {
    await fx.repo('Customer').create({ name: 'A', email: 'a@a.test' }, { tenantId: TENANT_A })
    expect(await fx.db.query('SELECT * FROM customers')).toEqual([])
    const counted = await fx.db.transaction(
      (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM customers'),
      { tenantId: TENANT_A },
    )
    expect(counted).toEqual([{ n: 1 }])
  })

  it('a tenant sees only its rows even without a WHERE clause', async () => {
    await fx.repo('Customer').create({ name: 'A', email: 'a@a.test' }, { tenantId: TENANT_A })
    await fx.repo('Customer').create({ name: 'B', email: 'b@b.test' }, { tenantId: TENANT_B })
    const rows = await fx.db.transaction(
      (tx) => tx.query<{ name: string }>('SELECT name FROM customers'),
      {
        tenantId: TENANT_B,
      },
    )
    expect(rows).toEqual([{ name: 'B' }])
  })

  it('WITH CHECK blocks inserting or moving rows into another tenant', async () => {
    const now = new Date().toISOString()
    await expect(
      fx.db.transaction(
        (tx) =>
          tx.execute(
            'INSERT INTO customers (id, tenant_id, name, email, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)',
            ['0190a000-0000-7000-8000-0000000000c9', TENANT_B, 'X', 'x@x.test', now],
          ),
        { tenantId: TENANT_A },
      ),
    ).rejects.toThrow(/row-level security/)
    const a = await fx
      .repo('Customer')
      .create({ name: 'A', email: 'a@a.test' }, { tenantId: TENANT_A })
    await expect(
      fx.db.transaction(
        (tx) => tx.execute('UPDATE customers SET tenant_id = $1 WHERE id = $2', [TENANT_B, a.id]),
        {
          tenantId: TENANT_A,
        },
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('the tenant setting is transaction-local: it does not leak into the next query', async () => {
    await fx.repo('Customer').create({ name: 'A', email: 'a@a.test' }, { tenantId: TENANT_A })
    await fx.db.transaction((tx) => tx.query('SELECT 1'), { tenantId: TENANT_A })
    const [row] = await fx.db.query<{ v: string | null }>(
      "SELECT current_setting('app.tenant_id', true) AS v",
    )
    expect(row?.v ?? '').toBe('')
    expect(await fx.db.query('SELECT * FROM customers')).toEqual([])
  })

  it('rejects a non-UUID tenant before it reaches SQL', async () => {
    await expect(
      fx.db.transaction(async () => 1, { tenantId: "x'; DROP TABLE customers; --" }),
    ).rejects.toThrow(/tenantId must be a UUID/)
  })
})

describe('tenancy migrations on Postgres', () => {
  it('turning tenancy off drops the policies before the tenant column', async () => {
    const Scoped = defineModel('Customer', { name: field.string(120) }, { tenant: true })
    const fx = await setupDatabase('postgres', [Scoped.definition])
    try {
      const Plain = defineModel('Customer', { name: field.string(120) })
      const plan = await planMigration({
        dialect: 'postgres',
        previous: [Scoped.definition],
        next: [Plain.definition],
        allowDestructive: true,
      })
      for (const s of plan.statements) await fx.db.execute(s)
      expect(await tenancyAudit(fx.db)).toEqual([{ table: '*', problem: 'role-bypasses-rls' }])
    } finally {
      await fx.db.close()
    }
  })

  it('the audit flags tenant tables without RLS', async () => {
    const fx = await setupDatabase('postgres', [])
    try {
      await fx.db.execute('CREATE TABLE leaky (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)')
      const findings = await tenancyAudit(fx.db)
      expect(findings).toEqual(
        expect.arrayContaining([
          { table: 'leaky', problem: 'rls-disabled' },
          { table: 'leaky', problem: 'rls-not-forced' },
          { table: 'leaky', problem: 'no-restrictive-policy' },
        ]),
      )
    } finally {
      await fx.db.close()
    }
  })
})

describe('tenancy audit: ways around RLS', () => {
  let fx: Fixture
  beforeEach(async () => {
    fx = await setupDatabase('postgres', models)
    await fx.db.execute('CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS')
    await fx.db.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON customers, invoices TO app_user')
  })
  afterEach(async () => {
    await fx.db.close()
  })
  const auditAsApp = async () => {
    await fx.db.execute('SET ROLE app_user')
    try {
      return await tenancyAudit(fx.db)
    } finally {
      await fx.db.execute('RESET ROLE')
    }
  }

  it('a runtime role that owns a tenant table is flagged (it could disable RLS)', async () => {
    await fx.db.execute('ALTER TABLE customers OWNER TO app_user')
    expect(await auditAsApp()).toEqual([{ table: 'customers', problem: 'role-owns-table' }])
  })

  it('views over tenant tables must be security_invoker; materialized views are always flagged', async () => {
    await fx.db.execute('CREATE VIEW all_customers AS SELECT * FROM customers')
    await fx.db.execute(
      'CREATE VIEW safe_customers WITH (security_invoker = true) AS SELECT * FROM customers',
    )
    await fx.db.execute('CREATE MATERIALIZED VIEW customer_names AS SELECT name FROM customers')
    expect(await auditAsApp()).toEqual([
      { table: 'all_customers', problem: 'view-bypasses-rls' },
      { table: 'customer_names', problem: 'view-bypasses-rls' },
    ])
  })

  it('SECURITY DEFINER functions are flagged', async () => {
    await fx.db.execute(
      'CREATE FUNCTION count_all() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$ SELECT count(*) FROM customers $$',
    )
    expect(await auditAsApp()).toEqual([
      { table: 'count_all', problem: 'security-definer-function' },
    ])
  })

  it('a restrictive policy that does not check the tenant setting is flagged', async () => {
    await fx.db.execute('DROP POLICY "tenant_isolation" ON invoices')
    await fx.db.execute(
      'CREATE POLICY "looks_safe" ON invoices AS RESTRICTIVE FOR ALL USING (true) WITH CHECK (true)',
    )
    expect(await auditAsApp()).toEqual([{ table: 'invoices', problem: 'tenant-policy-mismatch' }])
  })
})
