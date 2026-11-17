/**
 * Writes a synthetic app with many migrations, for timing approach (a) against approach (b) at a
 * realistic size. Each table gets a create migration and a later alter migration (add, rename,
 * index), so the replay exercises the same paths as a real project.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `@strutvane/framework/schema` as a file URL, so the generated app works from any folder. */
const SCHEMA_IMPORT = JSON.stringify(
  new URL('../../../src/entries/schema.ts', import.meta.url).href,
)

/**
 * Create `tables` tables (so `2 × tables` migration files) under `root/database/migrations`, and
 * return that folder.
 *
 * @example
 * writeSyntheticApp('.tmp/big', 100) // 200 migration files
 */
export function writeSyntheticApp(root: string, tables: number): string {
  const directory = join(root, 'database', 'migrations')
  mkdirSync(directory, { recursive: true })
  for (let index = 1; index <= tables; index++) {
    const table = tableName(index)
    writeFileSync(
      join(directory, `2026_01_01_${String(index * 2).padStart(6, '0')}_create_${table}_table.ts`),
      createMigration(table, index),
    )
    writeFileSync(
      join(
        directory,
        `2026_01_01_${String(index * 2 + 1).padStart(6, '0')}_add_code_to_${table}_table.ts`,
      ),
      alterMigration(table),
    )
  }
  return directory
}

function tableName(index: number): string {
  return `table_${String(index).padStart(3, '0')}`
}

function createMigration(table: string, index: number): string {
  // Every table after the first points at the previous one, so foreign keys are exercised too.
  const parent =
    index > 1
      ? `      t.foreignId('parent_id').nullable().constrained('${tableName(index - 1)}').nullOnDelete()\n`
      : ''
  return [
    `import { migration } from ${SCHEMA_IMPORT}`,
    '',
    'export default migration({',
    '  up(schema) {',
    `    schema.create('${table}', (t) => {`,
    '      t.id()',
    "      t.string('name', 120)",
    "      t.slug('slug').from('name')",
    "      t.text('description').nullable()",
    "      t.decimal('amount', 12, 2).default(0)",
    "      t.enum('state', ['new', 'active', 'closed']).default('new')",
    "      t.boolean('flagged').default(false)",
    "      t.date('due_on').nullable()",
    `${parent}      t.timestamps()`,
    '    })',
    '  },',
    '  down(schema) {',
    `    schema.dropIfExists('${table}')`,
    '  },',
    '})',
    '',
  ].join('\n')
}

function alterMigration(table: string): string {
  return [
    `import { migration } from ${SCHEMA_IMPORT}`,
    '',
    'export default migration({',
    '  up(schema) {',
    `    schema.table('${table}', (t) => {`,
    "      t.string('code', 40).nullable().unique()",
    "      t.renameColumn('description', 'notes')",
    '    })',
    '  },',
    '  down(schema) {',
    `    schema.table('${table}', (t) => {`,
    "      t.renameColumn('notes', 'description')",
    "      t.dropColumn('code')",
    '    })',
    '  },',
    '})',
    '',
  ].join('\n')
}
