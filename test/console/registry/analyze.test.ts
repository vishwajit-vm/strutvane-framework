import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { compileProject } from '../../src/registry/compiler.ts'
import { cleanupTempDirs, FIXTURE_DIR, project } from './helpers.ts'

afterAll(cleanupTempDirs)

describe('static analysis of the fixture app', () => {
  const result = compileProject(FIXTURE_DIR)
  const registry = result.registry

  test('compiles with no diagnostics', () => {
    expect(result.diagnostics).toEqual([])
    expect(registry).toBeDefined()
  })

  test('models: names, fields and options', () => {
    const invoice = registry?.models.find((m) => m.name === 'Invoice')
    expect(invoice?.fields).toEqual(['number', 'customer', 'amount', 'status', 'dueDate', 'lines'])
    expect(invoice?.softDeletes).toBe(true)
    expect(invoice?.tenant).toBe(true)
    expect(registry?.models.map((m) => m.name)).toEqual([
      'Customer',
      'Invoice',
      'InvoiceLine',
      'Product',
      'Tag',
    ])
  })

  test('aliased imports and `satisfies` wrappers are recognised', () => {
    expect(registry?.models.find((m) => m.name === 'Product')?.fields).toEqual([
      'sku',
      'name',
      'active',
    ])
  })

  test('resources resolve their model through the import, and derive action permissions', () => {
    expect(registry?.resources).toEqual([
      { model: 'Customer', file: 'app/resources/customer.resource.ts' },
      { model: 'Invoice', file: 'app/resources/invoice.resource.ts' },
    ])
    expect(registry?.permissions).toContain('invoice.approve') // explicit
    expect(registry?.permissions).toContain('invoice.send') // derived: <resource>.<action>
    expect(registry?.permissions).toContain('invoice.restore') // softDeletes → restore/forceDelete
    expect(registry?.permissions).not.toContain('customer.restore') // no softDeletes
  })

  test('routes, jobs, listeners, commands and pages', () => {
    expect(registry?.routes.map((r) => `${r.method} ${r.path} ${r.name}`)).toEqual([
      'GET /health GET /health',
      'POST /reports/revenue reports.revenue',
    ])
    expect(registry?.jobs.map((j) => j.name)).toEqual(['send-invoice-reminders'])
    expect(registry?.listeners.map((l) => l.name)).toEqual(['invoice.sent'])
    expect(registry?.commands.map((c) => c.name)).toEqual(['report:monthly'])
    expect(registry?.pages.map((p) => p.route)).toEqual([
      '/dashboard',
      '/invoices',
      '/invoices/:id',
      '/invoices/:id/edit',
    ])
  })
})

describe('user code is never executed', () => {
  test('a model file with side effects compiles without running them', () => {
    const root = project({
      'app/models/evil.model.ts': [
        "import { writeFileSync } from 'node:fs'",
        "import { defineModel, field } from '@strutvane/framework'",
        "writeFileSync('PWNED.txt', 'executed')",
        "throw new Error('this file was executed')",
        "export default defineModel('Evil', { title: field.string() })",
        '',
      ].join('\n'),
    })
    const result = compileProject(root)
    expect(result.diagnostics).toEqual([])
    expect(result.registry?.models.map((m) => m.name)).toEqual(['Evil'])
    expect(existsSync(join(root, 'PWNED.txt'))).toBe(false)
    expect(existsSync('PWNED.txt')).toBe(false)
  })
})
