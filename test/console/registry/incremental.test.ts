import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { RegistryCompiler } from '../../../src/console/registry/compiler.ts'
import { cleanupTempDirs, copyFixture, modelSource } from './helpers.ts'

afterAll(cleanupTempDirs)

describe('incremental compilation', () => {
  const root = copyFixture()
  const compiler = new RegistryCompiler(root)
  const models = () => compiler.compile().registry?.models.map((m) => m.name)

  test('cold run analyzes every file; an unchanged re-run analyzes none', () => {
    expect(compiler.compile().stats.analyzed).toBe(17)
    expect(compiler.compile().stats.analyzed).toBe(0)
  })

  test('editing one file re-analyzes only that file', () => {
    writeFileSync(join(root, 'app/models/tag.model.ts'), modelSource('Tag', ['label', 'color']))
    const result = compiler.compile()
    expect(result.stats.analyzed).toBe(1)
    expect(result.registry?.models.find((m) => m.name === 'Tag')?.fields).toEqual([
      'label',
      'color',
    ])
  })

  test('adding a file', () => {
    writeFileSync(join(root, 'app/models/vendor.model.ts'), modelSource('Vendor', ['name']))
    const result = compiler.compile()
    expect(result.stats.analyzed).toBe(1)
    expect(result.registry?.models.map((m) => m.name)).toContain('Vendor')
    expect(result.registry?.permissions).toContain('vendor.viewAny')
  })

  test('renaming a file (and the model inside it)', () => {
    renameSync(join(root, 'app/models/vendor.model.ts'), join(root, 'app/models/supplier.model.ts'))
    writeFileSync(join(root, 'app/models/supplier.model.ts'), modelSource('Supplier', ['name']))
    const names = models()
    expect(names).toContain('Supplier')
    expect(names).not.toContain('Vendor')
  })

  test('deleting a file removes it and its permissions', () => {
    rmSync(join(root, 'app/models/supplier.model.ts'))
    const result = compiler.compile()
    expect(result.registry?.models.map((m) => m.name)).not.toContain('Supplier')
    expect(result.registry?.permissions).not.toContain('supplier.view')
    expect(result.stats.analyzed).toBe(0)
  })

  test('write() only touches the disk when the output changes', () => {
    expect(compiler.write().written).toBe(true)
    expect(compiler.write().written).toBe(false)
  })

  test('cross-file effects are recomputed: deleting a model breaks the resource that imports it', () => {
    rmSync(join(root, 'app/models/customer.model.ts'))
    const result = compiler.compile()
    expect(result.output).toBeUndefined()
    expect(result.diagnostics.map((d) => [d.code, d.file])).toEqual(
      [
        ['UNKNOWN_MODEL', 'app/resources/customer.resource.ts'],
        ['UNKNOWN_MODEL', 'app/policies/customer.policy.ts'],
      ].sort((a, b) => ((a[1] ?? '') < (b[1] ?? '') ? -1 : 1)),
    )
  })
})
