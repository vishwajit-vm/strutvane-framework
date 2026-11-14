import { readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { compileProject } from '../../src/registry/compiler.ts'
import { verifyContentHash } from '../../src/registry/emit.ts'
import { cleanupTempDirs, copyFixture, FIXTURE_DIR, project } from './helpers.ts'

afterAll(cleanupTempDirs)

/** Every file under `dir` (relative POSIX paths), excluding generated output. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .replaceAll('\\', '/'),
    )
    .filter((p) => !p.startsWith('.strutvane/'))
}

describe('deterministic output', () => {
  test('two runs produce byte-identical output', () => {
    const a = compileProject(FIXTURE_DIR).output
    const b = compileProject(FIXTURE_DIR).output
    expect(a).toBeDefined()
    expect(a).toBe(b)
  })

  test('identical output from a copy whose files were created in reverse order with other mtimes', () => {
    const original = compileProject(FIXTURE_DIR).output
    const copy = copyFixture()
    const files = listFiles(copy).sort().reverse()
    const contents = new Map(files.map((f) => [f, readFileSync(join(copy, ...f.split('/')))]))
    for (const f of files) rmSync(join(copy, ...f.split('/')))
    let t = Date.now() - 10_000_000
    for (const f of files) {
      const abs = join(copy, ...f.split('/'))
      writeFileSync(abs, contents.get(f) ?? '')
      t += 1_000
      utimesSync(abs, new Date(t), new Date(t))
    }
    expect(compileProject(copy).output).toBe(original)
  })

  test('the output is portable: LF only, POSIX imports, no absolute or machine paths', () => {
    const copy = copyFixture()
    const output = compileProject(copy).output ?? ''
    expect(output).not.toContain('\r')
    expect(output.endsWith('\n')).toBe(true)
    expect(output.endsWith('\n\n')).toBe(false)
    expect(output).not.toContain('\\')
    expect(output).not.toContain(copy.replaceAll('\\', '/'))
    expect(output).not.toContain(tmpdir().replaceAll('\\', '/'))
    expect(output).not.toMatch(/[A-Za-z]:\//)
  })

  test('the header hash matches the body, and detects hand edits', () => {
    const output = compileProject(FIXTURE_DIR).output ?? ''
    expect(verifyContentHash(output)).toBe(true)
    expect(verifyContentHash(output.replace('"Invoice"', '"Invoize"'))).toBe(false)
  })

  test('import identifier collisions get stable suffixes', () => {
    const job = (name: string) =>
      `import { defineJob } from '@strutvane/framework'\nexport default defineJob('${name}', async () => {})\n`
    const root = project({ 'app/jobs/a-b.job.ts': job('one'), 'app/jobs/a_b.job.ts': job('two') })
    const output = compileProject(root).output ?? ''
    expect(output).toContain('import job_a_b from "../app/jobs/a-b.job.ts"')
    expect(output).toContain('import job_a_b_2 from "../app/jobs/a_b.job.ts"')
    expect(compileProject(root).output).toBe(output)
  })
})
