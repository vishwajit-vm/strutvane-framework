/**
 * Seeding as a generated app does it: `database.seeder.ts` in the canonical string form calling
 * the model seeders in dependency order, factories whose `related()` reuses the seeded parents,
 * and the `sv db:seed` warning for seeders nobody registered (the "Seeded DatabaseSeeder, 0 rows"
 * trap).
 */
import { afterEach, describe, expect, test } from 'vitest'
import {
  type CommandContextLike,
  commands,
  idleSeeders,
  seederClassName,
  seederFiles,
} from '../../src/commands.ts'
import { connectDatabase } from '../../src/database/connect.ts'
import { defineModel } from '../../src/model/define-model.ts'
import { field } from '../../src/model/field.ts'
import { migrationTarget } from '../../src/runtime/migrations.ts'
import { loadProject } from '../../src/runtime/project.ts'
import { createTestApp, defineFactory } from '../../src/testing/index.ts'
import { IMPORTS, makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function context(root: string, flags: CommandContextLike['flags'] = {}) {
  const lines: string[] = []
  const ctx: CommandContextLike = {
    flags,
    requireProject: () => ({ root }),
    out: {
      line: (t = '') => lines.push(t),
      success: (t) => lines.push(`ok ${t}`),
      info: (t) => lines.push(`info ${t}`),
      warn: (t) => lines.push(`warn ${t}`),
      table: (_h, rows) => lines.push(...rows.map((r) => r.join(' | '))),
    },
  }
  return { ctx, lines }
}

const run = async (name: string, root: string, flags: CommandContextLike['flags'] = {}) => {
  const c = commands.find((x) => x.name === name)
  if (!c) throw new Error(name)
  const out = context(root, flags)
  await c.run(out.ctx)
  return out.lines
}

const customerFiles = {
  'app/models/customer.model.ts': `import { defineModel, field } from '${IMPORTS.framework}'
export default defineModel('Customer', { name: field.string().required() })
`,
  'app/models/invoice.model.ts': `import { defineModel, field } from '${IMPORTS.framework}'
export default defineModel('Invoice', {
  number: field.string().required(),
  customer: field.belongsTo('Customer').required(),
})
`,
  'database/factories/customer.factory.ts': `import { defineFactory } from '${IMPORTS.testing}'
import Customer from '../../app/models/customer.model.ts'
export default defineFactory(Customer, ({ sequence }) => ({ name: 'Customer ' + sequence }))
`,
  'database/factories/invoice.factory.ts': `import { defineFactory } from '${IMPORTS.testing}'
import Invoice from '../../app/models/invoice.model.ts'
export default defineFactory(Invoice, ({ related, sequence }) => ({
  number: 'INV-' + sequence,
  customer: related('Customer'),
}))
`,
  'database/seeders/customer.seeder.ts': `import { defineSeeder } from '${IMPORTS.database}'
import CustomerFactory from '../factories/customer.factory.ts'
export default defineSeeder('CustomerSeeder', async ({ create }) => {
  await create(CustomerFactory, 3)
})
`,
  'database/seeders/invoice.seeder.ts': `import { defineSeeder } from '${IMPORTS.database}'
import InvoiceFactory from '../factories/invoice.factory.ts'
export default defineSeeder('InvoiceSeeder', async ({ create }) => {
  await create(InvoiceFactory, 7)
})
`,
}

/** The starter's empty orchestrator (create-strutvane's canonical database.seeder.ts). */
const EMPTY_ORCHESTRATOR = `import { defineSeeder } from '${IMPORTS.database}'

export default defineSeeder('DatabaseSeeder', async () => {
  // \`sv make:model\` adds \`await call(…)\` lines here, parents before children.
})
`

/** What `sv make:model Customer` then `sv make:model Invoice` leave behind. */
const REGISTERED_ORCHESTRATOR = `import { defineSeeder } from '${IMPORTS.database}'
import CustomerSeeder from './customer.seeder.ts'
import InvoiceSeeder from './invoice.seeder.ts'

export default defineSeeder('DatabaseSeeder', async ({ call }) => {
  // \`sv make:model\` adds \`await call(…)\` lines here, parents before children.
  await call(CustomerSeeder)
  await call(InvoiceSeeder)
})
`

async function seededProject(orchestrator: string): Promise<string> {
  const files = projectFiles({
    ...customerFiles,
    'database/seeders/database.seeder.ts': orchestrator,
  })
  // The fixture's routes and resources are about invoices with other fields; drop them here.
  delete files['app/http/routes/api.ts']
  const p = await makeProject(files)
  cleanups.push(p.cleanup)
  await run('migrate', p.root)
  return p.root
}

async function count(root: string, sql: string): Promise<number> {
  const db = await connectDatabase(migrationTarget(await loadProject(root)).connection)
  try {
    return Number((await db.query(sql))[0]?.['n'])
  } finally {
    await db.close()
  }
}

describe('sv db:seed', () => {
  test('runs the registered seeders in order; invoices reuse the seeded customers', async () => {
    const root = await seededProject(REGISTERED_ORCHESTRATOR)
    const lines = await run('db:seed', root)
    expect(lines).toEqual([
      'ok Seeded DatabaseSeeder',
      'ok Seeded CustomerSeeder',
      'ok Seeded InvoiceSeeder',
    ])
    expect(await count(root, 'SELECT COUNT(*) AS n FROM "customers"')).toBe(3)
    expect(await count(root, 'SELECT COUNT(*) AS n FROM "invoices"')).toBe(7)
    // Spread over all three customers, none created on the side.
    expect(await count(root, 'SELECT COUNT(DISTINCT "customer_id") AS n FROM "invoices"')).toBe(3)
  })

  test('warns, naming the files and the fix, when DatabaseSeeder ran nothing', async () => {
    const root = await seededProject(EMPTY_ORCHESTRATOR)
    const lines = await run('db:seed', root)
    expect(lines[0]).toBe('ok Seeded DatabaseSeeder')
    const warnings = lines.filter((l) => l.startsWith('warn '))
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('customer.seeder.ts, invoice.seeder.ts')
    expect(warnings[1]).toContain('await call(CustomerSeeder); await call(InvoiceSeeder)')
    expect(warnings[1]).toContain('--class CustomerSeeder')
    // Running one seeder by name never warns.
    const one = await run('db:seed', root, { class: 'CustomerSeeder' })
    expect(one).toEqual(['ok Seeded CustomerSeeder'])
  })

  test('helpers: class names, seeder files and when to warn', async () => {
    expect(seederClassName('invoice.seeder.ts')).toBe('InvoiceSeeder')
    expect(seederClassName('invoice-line.seeder.ts')).toBe('InvoiceLineSeeder')
    expect(seederClassName('order_item.seeder.ts')).toBe('OrderItemSeeder')
    expect(await seederFiles('/does/not/exist')).toEqual([])
    expect(idleSeeders(['DatabaseSeeder'], ['a.seeder.ts'])).toEqual([
      { file: 'a.seeder.ts', name: 'ASeeder' },
    ])
    expect(idleSeeders(['DatabaseSeeder', 'ASeeder'], ['a.seeder.ts', 'b.seeder.ts'])).toEqual([])
    expect(idleSeeders(['DatabaseSeeder'], [])).toEqual([])
  })
})

describe("factories: related('Model')", () => {
  test('reuses existing parents in turn, creates one on an empty table, or always with create: true', async () => {
    const Owner = defineModel('Owner', { name: field.string() })
    const Thing = defineModel('Thing', {
      name: field.string(),
      owner: field.belongsTo('Owner'),
    })
    const t = await createTestApp({ resources: [Owner, Thing] })
    cleanups.push(() => t.close())
    const reuse = defineFactory(Thing, ({ related, sequence }) => ({
      name: `reuse-${sequence}`,
      owner: related('Owner'),
    }))
    const fresh = defineFactory(Thing, ({ related, sequence }) => ({
      name: `new-${sequence}`,
      owner: related('Owner', { create: true }),
    }))
    const countCustomers = async () =>
      Number((await t.db.query('SELECT COUNT(*) AS n FROM "owners"'))[0]?.['n'])

    // Empty table: the first record creates its parent, the next ones reuse it.
    const first = (await reuse.createMany(t, 3)) as unknown as { owner: string }[]
    expect(await countCustomers()).toBe(1)
    expect(new Set(first.map((i) => i.owner)).size).toBe(1)

    // create: true always makes a new parent.
    await fresh.createMany(t, 2)
    expect(await countCustomers()).toBe(3)

    // With several parents, children are spread over them in turn.
    const spread = (await reuse.createMany(t, 3)) as unknown as { owner: string }[]
    expect(await countCustomers()).toBe(3)
    expect(new Set(spread.map((i) => i.owner)).size).toBe(3)
  })
})
