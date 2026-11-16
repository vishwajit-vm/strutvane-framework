/**
 * Hints name the project's own package manager (packaging audit: leftover pnpm wording). One
 * detection rule for the runtime and the CLI: the `packageManager` field, then the lockfile, then
 * npm. A regression test for the class: no user-facing text in `src/` names pnpm or corepack as
 * *the* way to run something.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectPackageManager, installCommand } from '../../src/core/package-manager.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sv-pm-'))
  dirs.push(root)
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text)
  return root
}

describe('detectPackageManager', () => {
  it('field first, then lockfile, else npm', async () => {
    expect(detectPackageManager(await project({}))).toBe('npm')
    expect(detectPackageManager(await project({ 'pnpm-lock.yaml': '' }))).toBe('pnpm')
    expect(detectPackageManager(await project({ 'yarn.lock': '' }))).toBe('yarn')
    expect(detectPackageManager(await project({ 'bun.lock': '' }))).toBe('bun')
    expect(
      detectPackageManager(
        await project({ 'package.json': '{"packageManager":"yarn@4.0.0"}', 'pnpm-lock.yaml': '' }),
      ),
    ).toBe('yarn')
    expect(detectPackageManager(await project({ 'package.json': '{not json' }))).toBe('npm')
    expect(installCommand('pnpm')).toBe('pnpm install')
  })
})

describe('no leftover pnpm/corepack instructions in user-facing source text', () => {
  it('src/ never tells users to run pnpm or corepack', async () => {
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        // The detection module names every package manager on purpose.
        else if (entry.name.endsWith('.ts') && entry.name !== 'package-manager.ts') {
          const text = await readFile(path, 'utf8')
          for (const [i, line] of text.split('\n').entries()) {
            if (/corepack|pnpm (sv|add|install|exec|run)\b/.test(line))
              offenders.push(`${path}:${i + 1}`)
          }
        }
      }
    }
    await walk(join(import.meta.dirname, '../../src'))
    expect(offenders).toEqual([])
  })
})
