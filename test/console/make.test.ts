/**
 * The make:* generators: golden outputs, idempotency, dry runs that write nothing, --force and
 * owned files, registry integration, and validation errors.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { compileProject } from '../../src/console/registry/compiler.ts'
import { recordEjection } from '../../src/devkit/index.ts'
import {
  cleanupTempDirs,
  cli,
  listFiles,
  makeProject,
  read,
  scriptedPrompter,
  snapshotTree,
  write,
} from './helpers.ts'

afterAll(cleanupTempDirs)

const INVOICE_FIELDS = [
  'number:string(40):required:unique:searchable',
  'customer:belongsTo(Customer):filterable',
  'amount:decimal(12,2):min(0):sortable',
  'status:enum(draft,sent,paid):default(draft):filterable',
  'dueDate:date:label("Due date")',
  'paid:boolean:default(false)',
  'lines:hasMany(InvoiceLine)',
]

const golden = (name: string): string => `./__golden__/${name}.snap`

describe('make:model', () => {
  test('models are tenant-scoped by default in apps with config/tenancy.ts (fail closed); --no-tenant opts out', async () => {
    const root = makeProject({ 'config/tenancy.ts': 'export default {}\n' })
    expect((await cli(['make:model', 'Invoice', 'number:string'], { cwd: root })).code).toBe(0)
    expect(read(root, 'app/models/invoice.model.ts')).toContain('tenant: true')
    expect(
      (await cli(['make:model', 'Country', 'name:string', '--no-tenant'], { cwd: root })).code,
    ).toBe(0)
    expect(read(root, 'app/models/country.model.ts')).toContain('tenant: false')
    const plain = makeProject()
    expect((await cli(['make:model', 'Invoice', 'number:string'], { cwd: plain })).code).toBe(0)
    expect(read(plain, 'app/models/invoice.model.ts')).not.toContain('tenant:')
  })

  test('golden output: model, policy, factory, seeder and feature test', async () => {
    const root = makeProject()
    const r = await cli(
      ['make:model', 'Invoice', ...INVOICE_FIELDS, '--soft-deletes', '--tenant', '--json'],
      { cwd: root },
    )
    expect(r.code, r.stdout).toBe(0)
    const data = r.json().data as {
      files: { path: string; action: string }[]
      registryUpdated: boolean
    }
    expect(data.files).toEqual([
      { path: 'app/models/invoice.model.ts', action: 'create' },
      { path: 'app/policies/invoice.policy.ts', action: 'create' },
      { path: 'database/factories/invoice.factory.ts', action: 'create' },
      { path: 'database/seeders/invoice.seeder.ts', action: 'create' },
      { path: 'tests/feature/invoices.test.ts', action: 'create' },
      { path: 'database/seeders/database.seeder.ts', action: 'create' },
    ])
    await expect(read(root, 'app/models/invoice.model.ts')).toMatchFileSnapshot(
      golden('invoice.model.ts'),
    )
    await expect(read(root, 'app/policies/invoice.policy.ts')).toMatchFileSnapshot(
      golden('invoice.policy.ts'),
    )
    await expect(read(root, 'database/factories/invoice.factory.ts')).toMatchFileSnapshot(
      golden('invoice.factory.ts'),
    )
    await expect(read(root, 'database/seeders/invoice.seeder.ts')).toMatchFileSnapshot(
      golden('invoice.seeder.ts'),
    )
    await expect(read(root, 'tests/feature/invoices.test.ts')).toMatchFileSnapshot(
      golden('invoices.test.ts'),
    )
  })

  test('generated files are read by the registry compiler (and the registry is refreshed)', async () => {
    const root = makeProject()
    await cli(['make:model', 'Customer', 'name:string:required'], { cwd: root })
    const r = await cli(
      ['make:model', 'Invoice', ...INVOICE_FIELDS, '--soft-deletes', '--all', '--json'],
      { cwd: root },
    )
    expect(r.code).toBe(0)
    expect((r.json().data as { registryUpdated: boolean }).registryUpdated).toBe(true)
    expect(existsSync(join(root, '.strutvane', 'registry.gen.ts'))).toBe(true)
    const result = compileProject(root)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const invoice = result.registry?.models.find((m) => m.name === 'Invoice')
    expect(invoice?.softDeletes).toBe(true)
    expect(invoice?.fieldDetails.find((f) => f.name === 'customer')).toEqual({
      name: 'customer',
      type: 'belongsTo',
      target: 'Customer',
    })
    expect(result.registry?.policies.map((p) => p.resource)).toEqual(['customer', 'invoice'])
    expect(result.registry?.resources.map((x) => x.model)).toEqual(['Invoice'])
    expect(result.registry?.permissions).toContain('invoice.forceDelete')
  })

  test('idempotent: the same command twice changes nothing the second time', async () => {
    const root = makeProject()
    const argv = ['make:model', 'Tag', 'name:string:required', '--json']
    expect((await cli(argv, { cwd: root })).code).toBe(0)
    const before = snapshotTree(root)
    const again = await cli(argv, { cwd: root })
    expect(again.code).toBe(0)
    expect(
      (again.json().data as { files: { action: string }[] }).files.every(
        (f) => f.action === 'unchanged',
      ),
    ).toBe(true)
    expect(snapshotTree(root)).toEqual(before)
    const human = await cli(argv.slice(0, -1), { cwd: root })
    expect(human.stdout).toContain('Nothing to do')
  })

  test('--dry-run writes nothing (with and without --diff)', async () => {
    const root = makeProject()
    const before = snapshotTree(root)
    const r = await cli(['make:model', 'Invoice', ...INVOICE_FIELDS, '--dry-run', '--diff'], {
      cwd: root,
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('+++ b/app/models/invoice.model.ts')
    expect(r.stdout).toContain('would create')
    expect(snapshotTree(root)).toEqual(before)
    const json = await cli(['make:model', 'Invoice', '--dry-run', '--json'], { cwd: root })
    expect(json.json().data).toMatchObject({ dryRun: true })
    expect(snapshotTree(root)).toEqual(before)
  })

  test('--diff without --dry-run asks before writing (and --yes / a declined confirm)', async () => {
    const root = makeProject()
    const declined = await cli(['make:model', 'Tag', 'name:string', '--diff'], {
      cwd: root,
      prompter: scriptedPrompter([false]),
    })
    expect(declined.code).toBe(130)
    expect(existsSync(join(root, 'app/models/tag.model.ts'))).toBe(false)
    const accepted = await cli(['make:model', 'Tag', 'name:string', '--diff'], {
      cwd: root,
      prompter: scriptedPrompter([true]),
    })
    expect(accepted.code).toBe(0)
    expect(existsSync(join(root, 'app/models/tag.model.ts'))).toBe(true)
  })

  test('an existing file with different content is a conflict (exit 4) unless --force', async () => {
    const root = makeProject()
    await cli(['make:model', 'Tag', 'name:string'], { cwd: root })
    const conflict = await cli(['make:model', 'Tag', 'name:text', '--json'], { cwd: root })
    expect(conflict.code).toBe(4)
    expect(conflict.json().error).toMatchObject({ code: 'file_exists' })
    expect(read(root, 'app/models/tag.model.ts')).toContain('field.string()')
    const forced = await cli(['make:model', 'Tag', 'name:text', '--force', '--json'], { cwd: root })
    expect(forced.code, forced.stdout + forced.stderr).toBe(0)
    expect(read(root, 'app/models/tag.model.ts')).toContain('field.text()')
  })

  test('--force never overwrites owned files (tracked in .strutvane/lock.json)', async () => {
    const root = makeProject()
    await recordEjection({
      projectRoot: root,
      outputs: [
        {
          path: 'app/models/tag.model.ts',
          template: 'framework/model',
          version: '0.1.0',
          content: '// owned\n',
        },
      ],
    })
    const r = await cli(['make:model', 'Tag', 'name:string', '--force', '--json'], { cwd: root })
    expect(r.code).toBe(4)
    expect(r.json().error?.code).toBe('owned_file')
    expect(read(root, 'app/models/tag.model.ts')).toBe('// owned\n')
  })

  test('companion toggles, model options and --seed', async () => {
    const root = makeProject()
    const r = await cli(
      [
        'make:model',
        'AuditEntry',
        'note:text',
        '--no-policy',
        '--no-factory',
        '--no-seeder',
        '--no-test',
        '--no-api',
        '--no-ui',
        '--no-timestamps',
        '--audit',
        '--no-tenant',
        '--json',
      ],
      { cwd: root },
    )
    expect(r.code).toBe(0)
    expect(listFiles(root).filter((f) => !f.startsWith('.strutvane'))).toEqual([
      'app/models/audit-entry.model.ts',
      'package.json',
      'strutvane.config.ts',
    ])
    expect(read(root, 'app/models/audit-entry.model.ts')).toContain(
      '{ timestamps: false, tenant: false, audit: true, api: false, ui: false }',
    )
    const seeded = await cli(['make:model', 'Item', '--seed', '25', '--no-test'], {
      cwd: makeProject(),
    })
    expect(seeded.code).toBe(0)
    const bad = await cli(['make:model', 'Item', '--seed', 'lots', '--json'], {
      cwd: makeProject(),
    })
    expect(bad.json().error?.code).toBe('invalid_flag_value')
  })

  test('feature test falls back to a plain test when the API is disabled', async () => {
    const root = makeProject()
    await cli(['make:model', 'Setting', 'key:string', '--no-api'], { cwd: root })
    expect(read(root, 'tests/feature/settings.test.ts')).not.toContain('/api/v1/')
  })

  test('invalid fields are validation errors (exit 3) with the column', async () => {
    const r = await cli(
      ['make:model', 'Invoice', 'status:enum(draft,paid):default(sent)', '--json'],
      { cwd: makeProject() },
    )
    expect(r.code).toBe(3)
    expect(r.json().error).toMatchObject({ code: 'invalid_field' })
    expect(r.json().error?.message).toContain('column 33')
    const human = await cli(['make:model', 'Invoice', 'x:strng'], { cwd: makeProject() })
    expect(human.stderr).toContain('Did you mean string')
    expect(human.stderr).toContain('hint: Field syntax')
    expect(
      (await cli(['make:model', 'Invoice', 'a:string', 'a:text'], { cwd: makeProject() })).code,
    ).toBe(3)
  })

  test('invalid model names are rejected (exit 3), including path tricks', async () => {
    for (const name of ['../evil', 'a/b', '1Up']) {
      const r = await cli(['make:model', name, '--json'], { cwd: makeProject() })
      expect(r.code, name).toBe(3)
      expect(r.json().error?.code).toBe('invalid_name')
    }
  })

  test('the interactive field builder (TTY, no fields)', async () => {
    const root = makeProject()
    const prompter = scriptedPrompter(['title:string(200):required', 'price:decimal(8,2)', ''])
    const r = await cli(['make:model', 'Product'], { cwd: root, prompter })
    expect(r.code).toBe(0)
    expect(prompter.asked).toHaveLength(3)
    expect(read(root, 'app/models/product.model.ts')).toContain('price: field.decimal(8, 2),')
  })

  test('Windows-style names and paths: generated paths are always POSIX and lowercase-kebab', async () => {
    const root = makeProject()
    const r = await cli(['make:model', 'InvoiceLine', 'qty:integer', '--json'], { cwd: root })
    const paths = (r.json().data as { files: { path: string }[] }).files.map((f) => f.path)
    for (const p of paths) {
      expect(p).not.toContain('\\')
      if (p !== 'database/seeders/database.seeder.ts') expect(p).toMatch(/invoice-line/)
    }
    expect(read(root, 'database/seeders/database.seeder.ts')).toContain(
      "import InvoiceLineSeeder from './invoice-line.seeder.ts'",
    )
  })
})

describe('other generators', () => {
  async function withModel(): Promise<string> {
    const root = makeProject()
    await cli(
      ['make:model', 'Invoice', ...INVOICE_FIELDS, '--soft-deletes', '--no-policy', '--no-factory'],
      { cwd: root },
    )
    return root
  }

  test('make:resource with actions and hooks (golden), registered with permissions', async () => {
    const root = await withModel()
    const r = await cli(
      [
        'make:resource',
        'Invoice',
        '--actions',
        'approve,sendReminder',
        '--hooks',
        'beforeCreate,afterUpdate',
      ],
      { cwd: root },
    )
    expect(r.code, r.stderr).toBe(0)
    await expect(read(root, 'app/resources/invoice.resource.ts')).toMatchFileSnapshot(
      golden('invoice.resource.ts'),
    )
    expect(compileProject(root).registry?.permissions).toEqual(
      expect.arrayContaining(['invoice.approve', 'invoice.sendReminder']),
    )
  })

  test('make:resource validates action and hook names (exit 3)', async () => {
    const root = await withModel()
    const r = await cli(['make:resource', 'Invoice', '--hooks', 'onWhatever', '--json'], {
      cwd: root,
    })
    expect(r.code).toBe(3)
    expect(r.json().error?.code).toBe('generator_input_invalid')
    expect(
      (await cli(['make:resource', 'Invoice', '--actions', 'Bad-Action'], { cwd: root })).code,
    ).toBe(3)
  })

  test('generators that build on a model require it (model_not_found, exit 3)', async () => {
    const root = makeProject()
    for (const command of ['make:resource', 'make:policy', 'make:factory']) {
      const r = await cli([command, 'Ghost', '--json'], { cwd: root })
      expect(r.code, command).toBe(3)
      expect(r.json().error?.code).toBe('model_not_found')
    }
  })

  test('make:policy templates (golden for owner); soft-delete actions follow the model', async () => {
    const root = await withModel()
    expect((await cli(['make:policy', 'Invoice', '--template', 'owner'], { cwd: root })).code).toBe(
      0,
    )
    await expect(read(root, 'app/policies/invoice.policy.ts')).toMatchFileSnapshot(
      golden('invoice.owner.policy.ts'),
    )
    for (const template of ['tenant-admin', 'readonly', 'default']) {
      const r = await cli(['make:policy', 'Invoice', '--template', template, '--force'], {
        cwd: root,
      })
      expect(r.code, template).toBe(0)
    }
    expect(read(root, 'app/policies/invoice.policy.ts')).toContain("'restore', 'forceDelete'")
    expect((await cli(['make:policy', 'Invoice', '--template', 'nope'], { cwd: root })).code).toBe(
      2,
    )
  })

  test('make:policy templates use the role vocabulary of config/auth.ts (docs/07 §2.7)', async () => {
    const root = await withModel()
    const roleNames = (source: string): string[] =>
      [...source.matchAll(/role: (\[[^\]]*\]|'[^']*')/g)].flatMap((m) =>
        [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((r) => r[1] ?? ''),
      )
    const seen = new Set<string>()
    for (const template of ['default', 'owner', 'tenant-admin', 'readonly']) {
      expect(
        (await cli(['make:policy', 'Invoice', '--template', template, '--force'], { cwd: root }))
          .code,
      ).toBe(0)
      const source = read(root, 'app/policies/invoice.policy.ts')
      for (const role of roleNames(source)) seen.add(role)
      if (template === 'tenant-admin') {
        // Tenant administration is the admin or owner role held INSIDE the tenant.
        expect(source).toContain(
          "{ role: ['viewer', 'member', 'admin', 'owner'], scope: 'tenant' }",
        )
        expect(source).toMatch(/role: \['admin', 'owner'\],\s+scope: 'tenant'/)
      }
      if (template === 'owner')
        expect(source).toMatch(/role: 'member',\s+when: \(\{ actor, row \}\) => row\.ownerId\.eq/)
    }
    expect([...seen].sort()).toEqual(['admin', 'member', 'owner', 'viewer'])
  })

  test('make:factory reads the model fields back (golden)', async () => {
    const root = await withModel()
    expect((await cli(['make:factory', 'Invoice'], { cwd: root })).code).toBe(0)
    await expect(read(root, 'database/factories/invoice.factory.ts')).toMatchFileSnapshot(
      golden('invoice.from-model.factory.ts'),
    )
  })

  test('make:seeder with and without a model', async () => {
    const root = makeProject()
    expect((await cli(['make:seeder', 'DemoData'], { cwd: root })).code).toBe(0)
    expect(read(root, 'database/seeders/demo-data.seeder.ts')).toContain(
      "defineSeeder('DemoDataSeeder'",
    )
    expect(
      (await cli(['make:seeder', 'Invoices', '--model', 'Invoice', '--count', '50'], { cwd: root }))
        .code,
    ).toBe(0)
    expect(read(root, 'database/seeders/invoices.seeder.ts')).toContain(
      'await create(InvoiceFactory, 50, scope)',
    )
    expect((await cli(['make:seeder', 'X', '--count', '0'], { cwd: root })).code).toBe(2)
  })

  test('make:test kinds', async () => {
    const root = makeProject()
    expect((await cli(['make:test', 'invoice-totals'], { cwd: root })).code).toBe(0)
    expect(
      (await cli(['make:test', 'InvoiceMath', '--unit', '--model', 'Invoice'], { cwd: root })).code,
    ).toBe(0)
    expect((await cli(['make:test', 'checkout', '--e2e'], { cwd: root })).code).toBe(0)
    expect(read(root, 'tests/feature/invoice-totals.test.ts')).toContain(
      'createTestApp({ resources: [] })',
    )
    expect(read(root, 'tests/unit/invoice-math.test.ts')).toContain(
      "expect(Invoice.name).toBe('Invoice')",
    )
    expect(read(root, 'tests/e2e/checkout.test.ts')).toContain('@playwright/test')
    expect((await cli(['make:test', 'x', '--unit', '--e2e'], { cwd: root })).code).toBe(2)
  })

  test('make:migration uses the injected clock (deterministic names), TS and SQL', async () => {
    const root = makeProject()
    const r = await cli(
      ['make:migration', 'backfill-invoice-totals', '--table', 'invoices', '--json'],
      { cwd: root },
    )
    expect((r.json().data as { files: { path: string }[] }).files[0]?.path).toBe(
      'database/migrations/20261114093000_backfill_invoice_totals.ts',
    )
    await expect(
      read(root, 'database/migrations/20261114093000_backfill_invoice_totals.ts'),
    ).toMatchFileSnapshot(golden('migration.ts'))
    const sql = await cli(['make:migration', 'raw_fix', '--sql', '--table', 'invoices', '--json'], {
      cwd: root,
      now: Date.UTC(2027, 0, 2, 3, 4, 5),
    })
    expect((sql.json().data as { files: { path: string }[] }).files[0]?.path).toBe(
      'database/migrations/20270102030405_raw_fix.sql',
    )
    // Regression: stubs match what @strutvane/framework runs (up({ db }); no schema builder, no SQL down section).
    const ts = read(root, 'database/migrations/20261114093000_backfill_invoice_totals.ts')
    expect(ts).toContain('async up({ db })')
    expect(ts).not.toContain('schema')
    expect(read(root, 'database/migrations/20270102030405_raw_fix.sql')).not.toContain('-- down')
    expect((await cli(['make:migration', 'plain'], { cwd: root })).code).toBe(0)
    const badTable = await cli(['make:migration', 'x', '--table', 'Bad Table', '--json'], {
      cwd: root,
    })
    expect(badTable.code).toBe(3)
  })
})

describe('registry refresh after generation', () => {
  test('registry errors after generation are reported as warnings, last good registry kept', async () => {
    const root = makeProject()
    write(root, 'app/models/broken.model.ts', 'export default 42\n')
    const r = await cli(['make:model', 'Tag', 'name:string', '--json'], { cwd: root })
    expect(r.code).toBe(0)
    expect(r.json().warnings.join('\n')).toContain('unexpected_default_export')
    expect(existsSync(join(root, '.strutvane/registry.gen.ts'))).toBe(false)
  })
})

/**
 * Antivirus scanners, indexers and editors open freshly written files on Windows without
 * FILE_SHARE_DELETE, so renaming over them fails with EPERM until they let go, often for a second
 * or more on a busy machine. `--force` must ride that out instead of rolling back (this made the
 * suite flaky under load). Reproduced for real: another process holds the target file open.
 */
describe.skipIf(process.platform !== 'win32')(
  'make:model --force over a file another process holds',
  () => {
    test('succeeds once the other process lets go (held 1.5 s)', async () => {
      const root = makeProject()
      await cli(['make:model', 'Tag', 'name:string'], { cwd: root })
      const file = join(root, 'app/models/tag.model.ts')
      const holder = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `$f=[System.IO.File]::Open('${file}','Open','Read','Read'); Write-Output locked; Start-Sleep -Milliseconds 1500; $f.Close()`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const exited = new Promise((resolve) => holder.once('exit', resolve))
      await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
      const forced = await cli(['make:model', 'Tag', 'name:text', '--force', '--json'], {
        cwd: root,
      })
      await exited
      expect(forced.code, forced.stdout).toBe(0)
      expect(read(root, 'app/models/tag.model.ts')).toContain('field.text()')
    })
  },
)
