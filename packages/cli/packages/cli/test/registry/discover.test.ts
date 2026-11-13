import { afterAll, describe, expect, test } from 'vitest'
import { detectCaseConflicts, discover } from '../../src/registry/discover.ts'
import {
  identifierForFile,
  isValidPermission,
  modelNameFromFile,
  pageRoute,
  resourceKey,
} from '../../src/registry/names.ts'
import { compareCodeUnits, resolveRelativeImport, toPosix } from '../../src/registry/paths.ts'
import { cleanupTempDirs, FIXTURE_DIR, project } from './helpers.ts'

afterAll(cleanupTempDirs)

describe('discover', () => {
  test('finds every convention file of the fixture, sorted, POSIX, ignoring helpers/tests/lib', () => {
    const { files, diagnostics } = discover(FIXTURE_DIR)
    expect(diagnostics).toEqual([])
    expect(files.map((f) => `${f.kind}:${f.relPath}`)).toEqual([
      'command:app/commands/report-monthly.command.ts',
      'route:app/http/routes/api.ts',
      'job:app/jobs/send-invoice-reminders.job.ts',
      'listener:app/listeners/notify-on-invoice-sent.listener.ts',
      'model:app/models/customer.model.ts',
      'model:app/models/invoice-line.model.ts',
      'model:app/models/invoice.model.ts',
      'model:app/models/product.model.ts',
      'model:app/models/tag.model.ts',
      'policy:app/policies/customer.policy.ts',
      'policy:app/policies/invoice.policy.ts',
      'resource:app/resources/customer.resource.ts',
      'resource:app/resources/invoice.resource.ts',
      'page:web/pages/dashboard.tsx',
      'page:web/pages/invoices/[id].tsx',
      'page:web/pages/invoices/[id]/edit.tsx',
      'page:web/pages/invoices/index.tsx',
    ])
    for (const f of files) expect(f.relPath).not.toContain('\\')
  })

  test('warns about files whose suffix differs only by case (and ignores them)', () => {
    const root = project({ 'app/models/order.Model.ts': 'export default 1\n' })
    const { files, diagnostics } = discover(root)
    expect(files).toEqual([])
    expect(diagnostics.map((d) => [d.code, d.severity, d.file])).toEqual([
      ['SUSPICIOUS_FILE_NAME', 'warning', 'app/models/order.Model.ts'],
    ])
  })

  test('a missing convention folder is simply skipped', () => {
    expect(discover(project()).files).toEqual([])
  })
})

describe('case conflicts', () => {
  test('paths differing only by case are an error on every OS (Windows/macOS would collide)', () => {
    // Windows-style separators are normalised first. The report lands on the path that sorts
    // second in code-unit order ('I' < 'i'), whatever order the inputs arrive in.
    for (const input of [
      ['app/models/invoice.model.ts', 'app\\models\\Invoice.model.ts'],
      ['app\\models\\Invoice.model.ts', 'app/models/invoice.model.ts'],
    ]) {
      const diagnostics = detectCaseConflicts(input)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.code).toBe('CASE_CONFLICT')
      expect(diagnostics[0]?.file).toBe('app/models/invoice.model.ts')
      expect(diagnostics[0]?.message).toContain('app/models/Invoice.model.ts')
    }
  })
})

describe('paths', () => {
  test('toPosix converts Windows separators', () => {
    expect(toPosix('app\\models\\invoice.model.ts')).toBe('app/models/invoice.model.ts')
  })
  test('code-unit comparison is locale-independent (uppercase before lowercase, ä after z)', () => {
    expect(['b', 'a', 'B', 'ä', 'z'].sort(compareCodeUnits)).toEqual(['B', 'a', 'b', 'z', 'ä'])
  })
  test('resolveRelativeImport resolves ./ and ../, rejects packages and escapes', () => {
    expect(resolveRelativeImport('app/resources/x.resource.ts', '../models/invoice.model.ts')).toBe(
      'app/models/invoice.model.ts',
    )
    expect(resolveRelativeImport('app/resources/x.resource.ts', './y.ts')).toBe(
      'app/resources/y.ts',
    )
    expect(
      resolveRelativeImport('app/resources/x.resource.ts', '@strutvane/framework'),
    ).toBeUndefined()
    expect(resolveRelativeImport('a.ts', '../../outside.ts')).toBeUndefined()
  })
})

describe('names', () => {
  test('page routes from file paths', () => {
    const r = (p: string) => pageRoute(p, 'web/pages', '.tsx')
    expect(r('web/pages/index.tsx')).toBe('/')
    expect(r('web/pages/invoices/index.tsx')).toBe('/invoices')
    expect(r('web/pages/invoices/[id].tsx')).toBe('/invoices/:id')
    expect(r('web/pages/invoices/[id]/edit.tsx')).toBe('/invoices/:id/edit')
    expect(r('web/pages/docs/[...slug].tsx')).toBe('/docs/*')
    expect(r('web/pages/(admin)/users.tsx')).toBe('/users')
  })
  test('identifiers, resource keys, model names from files, permission format', () => {
    expect(
      identifierForFile('model', 'app/models/invoice-line.model.ts', 'app/models', '.model.ts'),
    ).toBe('model_invoice_line')
    expect(resourceKey('InvoiceLine')).toBe('invoiceLine')
    expect(modelNameFromFile('invoice-line.model.ts', '.model.ts')).toBe('InvoiceLine')
    expect(isValidPermission('invoice.viewAny')).toBe(true)
    expect(isValidPermission('*')).toBe(true)
    expect(isValidPermission('Invoice.Approve')).toBe(false)
    expect(isValidPermission('approve')).toBe(false)
  })
})
