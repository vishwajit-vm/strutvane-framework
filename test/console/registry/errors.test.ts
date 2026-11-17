import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { compileProject, RegistryCompiler } from '../../../src/console/registry/compiler.ts'
import { type Diagnostic, formatDiagnostic } from '../../../src/console/registry/errors.ts'
import { cleanupTempDirs, modelSource, project } from './helpers.ts'

afterAll(cleanupTempDirs)

const VALID = { 'app/models/order.model.ts': modelSource('Order', ['number']) }

/** Compile a project made of a valid model plus `files`; return all diagnostics. */
function diagnosticsFor(files: Record<string, string>): readonly Diagnostic[] {
  return compileProject(project({ ...VALID, ...files })).diagnostics
}

function only(files: Record<string, string>): Diagnostic {
  const diagnostics = diagnosticsFor(files)
  expect(diagnostics, diagnostics.map(formatDiagnostic).join('\n')).toHaveLength(1)
  return diagnostics[0] as Diagnostic
}

describe('per-file errors (with file:line:column and a fix hint)', () => {
  test('syntax error', () => {
    const d = only({
      'app/models/broken.model.ts':
        "import { defineModel } from '@strutvane/framework'\nexport default defineModel('Broken', {\n",
    })
    expect(d.code).toBe('parse_error')
    expect(d.file).toBe('app/models/broken.model.ts')
    expect(d.line).toBe(3)
    expect(d.hint).toBeDefined()
  })

  test('no default export', () => {
    const d = only({ 'app/models/nothing.model.ts': 'export const x = 1\n' })
    expect(d.code).toBe('missing_default_export')
    expect(d.hint).toContain('export default defineModel(…)')
  })

  test('default export is not a define call', () => {
    const d = only({ 'app/models/plain.model.ts': 'export default { name: "Plain" }\n' })
    expect(d.code).toBe('unexpected_default_export')
    expect([d.line, d.column]).toEqual([1, 16])
  })

  test('the wrong define* for the folder (defineResource in app/models)', () => {
    const d = only({
      'app/models/wrong.model.ts':
        "import { defineResource } from '@strutvane/framework'\nimport Order from './order.model.ts'\nexport default defineResource(Order)\n",
    })
    expect(d.code).toBe('unexpected_default_export')
    expect(d.message).toContain('found defineResource')
  })

  test('define* not imported from the framework (a look-alike cannot sneak in)', () => {
    const d = only({
      'app/models/fake.model.ts':
        "import { defineModel } from './my-own-thing.ts'\nexport default defineModel('Fake', {})\n",
    })
    expect(d.code).toBe('not_imported_from_framework')
  })

  test('a non-literal model name points at the exact argument', () => {
    const d = only({
      'app/models/dyn.model.ts':
        "import { defineModel, field } from '@strutvane/framework'\nconst name = 'Dyn'\nexport default defineModel(name, { a: field.string() })\n",
    })
    expect(d.code).toBe('non_literal_argument')
    expect([d.line, d.column]).toEqual([3, 28])
  })

  test('spread fields cannot be read statically', () => {
    const d = only({
      'app/models/spread.model.ts':
        "import { defineModel, field } from '@strutvane/framework'\nconst base = { a: field.string() }\nexport default defineModel('Spread', { ...base })\n",
    })
    expect(d.code).toBe('non_literal_argument')
  })

  test('model names must be PascalCase', () => {
    expect(only({ 'app/models/lower.model.ts': modelSource('lower') }).code).toBe(
      'invalid_model_name',
    )
  })

  test('file name mismatch is a warning and does not block output', () => {
    const result = compileProject(
      project({ ...VALID, 'app/models/customer.model.ts': modelSource('Client') }),
    )
    expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ['file_name_mismatch', 'warning'],
    ])
    expect(result.output).toBeDefined()
  })

  test('invalid routes', () => {
    const d = only({
      'app/http/routes/api.ts':
        "import { route } from '@strutvane/framework'\nexport default [route.get('no-slash')]\n",
    })
    expect(d.code).toBe('invalid_route')
  })
})

describe('cross-file errors', () => {
  test('duplicate model names: reported on the file that sorts second, naming the first', () => {
    // "First" is defined by code-unit path order ('.' < '2'), never by OS directory order, so the
    // same file gets the error on every machine. The extra file also gets a name-mismatch warning.
    const diagnostics = diagnosticsFor({ 'app/models/order2.model.ts': modelSource('Order') })
    const errors = diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe('duplicate_model')
    expect(errors[0]?.file).toBe('app/models/order2.model.ts')
    expect(errors[0]?.message).toContain('app/models/order.model.ts')
    expect(diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code)).toEqual([
      'file_name_mismatch',
    ])
  })

  test('policy for an unknown resource', () => {
    const d = only({
      'app/policies/ghost.policy.ts':
        "import { definePolicy } from '@strutvane/framework'\nexport default definePolicy('ghost', () => {})\n",
    })
    expect(d.code).toBe('unknown_model')
  })

  test('duplicate route, invalid permission, duplicate job, duplicate page URL', () => {
    const codes = diagnosticsFor({
      'app/http/routes/a.ts':
        "import { route } from '@strutvane/framework'\nexport default [route.get('/x'), route.get('/x')]\n",
      'app/http/routes/b.ts':
        "import { route } from '@strutvane/framework'\nexport default [route.get('/y', { permission: 'Report.Y' })]\n",
      'app/jobs/a.job.ts':
        "import { defineJob } from '@strutvane/framework'\nexport default defineJob('sync', async () => {})\n",
      'app/jobs/b.job.ts':
        "import { defineJob } from '@strutvane/framework'\nexport default defineJob('sync', async () => {})\n",
      'web/pages/invoices.tsx': 'export default () => null\n',
      'web/pages/invoices/index.tsx': 'export default () => null\n',
    }).map((d) => d.code)
    expect(codes.sort()).toEqual([
      'duplicate_job',
      'duplicate_page_route',
      'duplicate_route',
      'invalid_permission',
    ])
  })

  test('all problems are reported in one run, not just the first', () => {
    const diagnostics = diagnosticsFor({
      'app/models/a.model.ts': 'export const nothing = 1\n',
      'app/models/b.model.ts': 'export default {}\n',
      'app/models/c.model.ts':
        "import { defineModel } from '@strutvane/framework'\nexport default defineModel('C', {\n",
    })
    expect(diagnostics.map((d) => d.code)).toEqual([
      'missing_default_export',
      'unexpected_default_export',
      'parse_error',
    ])
  })

  test('formatted diagnostics read like compiler output with a hint line', () => {
    const d = only({ 'app/models/nothing.model.ts': 'export const x = 1\n' })
    expect(formatDiagnostic(d)).toMatch(
      /^app\/models\/nothing\.model\.ts:1:1 error missing_default_export .+\n {2}hint: /,
    )
  })
})

describe('fail closed: errors never produce or overwrite a registry', () => {
  test('the last good registry is kept until the error is fixed', () => {
    const root = project(VALID)
    const compiler = new RegistryCompiler(root)
    const first = compiler.write()
    expect(first.written).toBe(true)
    const good = readFileSync(first.outputPath, 'utf8')

    writeFileSync(join(root, 'app/models/order.model.ts'), 'export default {\n')
    const broken = compiler.write()
    expect(broken.written).toBe(false)
    expect(broken.result.output).toBeUndefined()
    expect(broken.result.diagnostics[0]?.code).toBe('parse_error')
    expect(readFileSync(first.outputPath, 'utf8')).toBe(good)

    writeFileSync(
      join(root, 'app/models/order.model.ts'),
      modelSource('Order', ['number', 'total']),
    )
    const fixed = compiler.write()
    expect(fixed.written).toBe(true)
    expect(readFileSync(first.outputPath, 'utf8')).toContain('"total"')
    expect(existsSync(`${first.outputPath}.${process.pid}.tmp`)).toBe(false)
  })
})
