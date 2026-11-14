/**
 * The generated registry must make permission/model/route typos COMPILE ERRORS.
 * These tests run the real TypeScript 6 compiler on a consumer file that imports the registry.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { RegistryCompiler } from '../../src/registry/compiler.ts'
import { cleanupTempDirs, copyFixture } from './helpers.ts'

afterAll(cleanupTempDirs)

const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc')

function tsc(root: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [TSC, '--noEmit', '-p', join(root, 'tsconfig.json')], {
    encoding: 'utf8',
  })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

function projectWithRegistry(consumer: string): string {
  const root = copyFixture()
  expect(new RegistryCompiler(root).write().written).toBe(true)
  writeFileSync(join(root, 'consumer.ts'), consumer)
  return root
}

const HEADER = `import { models, pages, permissions, type ModelName, type Permission, type RouteName, type JobName, type PagePath } from './.strutvane/registry.gen.ts'
declare function can(permission: Permission): boolean
`

describe('typed registry', () => {
  test('valid names compile, and every typo is rejected (@ts-expect-error must be "used")', () => {
    const root = projectWithRegistry(`${HEADER}
can('invoice.view')
can('report.revenue')
// @ts-expect-error typo in the action
can('invoice.aprove')
// @ts-expect-error permission of a model that does not exist
can('invoices.view')
const model: ModelName = 'InvoiceLine'
// @ts-expect-error unknown model
const badModel: ModelName = 'Invoices'
const routeName: RouteName = 'reports.revenue'
const job: JobName = 'send-invoice-reminders'
const page: PagePath = '/invoices/:id/edit'
// @ts-expect-error unknown page
const badPage: PagePath = '/invoice'
export const used = [models, pages, permissions, model, badModel, routeName, job, page, badPage]
`)
    const result = tsc(root)
    expect(result.output).toBe('')
    expect(result.status).toBe(0)
  })

  test('without @ts-expect-error, a typo is a real compile error naming the bad string', () => {
    const root = projectWithRegistry(`${HEADER}
can('invoice.aprove')
`)
    const result = tsc(root)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('TS2345')
    expect(result.output).toContain('invoice.aprove')
  })
})
