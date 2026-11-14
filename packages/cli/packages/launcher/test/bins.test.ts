/**
 * The `bin` entries of both published packages (`@strutvane/cli` → `strutvane-cli`, `strutvane`
 * → `strutvane`) point at an executable the build really produces.
 *
 * `ci` runs the tests before `tsdown`, so `dist/` may be missing (fresh clone) or stale here. The
 * test therefore checks the chain that produces each bin rather than only the file: the manifest
 * path is `dist/<name>.mjs` without a leading `./` (npm "auto-corrects" that on publish), the
 * workspace `tsdown.config.ts` builds that package from `src/<name>.ts`, and that source starts
 * with a `#!` line, which tsdown keeps (and marks the output executable). When the dist file
 * exists it is checked directly as well. Together these fail if a bin is renamed, its entry is
 * dropped from the build, or its shebang is lost.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = new URL('../../../', import.meta.url)

/**
 * The entries tsdown builds for a package, read from `tsdown.config.ts` as text: importing the
 * config would pull it into the type-checked program, and its exact shape (one object literal
 * per package, `cwd` then `entry`) is what this guards anyway.
 */
function buildEntries(dir: string): string[] | undefined {
  const text = readFileSync(new URL('tsdown.config.ts', ROOT), 'utf8')
  const line = text
    .split(/\r?\n/)
    .find((l) => l.includes(`cwd: 'packages/${dir}'`) && l.includes('entry:'))
  const list = line === undefined ? undefined : /entry:\s*\[([^\]]*)\]/.exec(line)?.[1]
  return list
    ?.split(',')
    .map((e) => e.trim().replace(/^'|'$/g, ''))
    .filter((e) => e !== '')
}

function manifest(pkg: string): { name: string; bin: Record<string, string> } {
  return JSON.parse(readFileSync(new URL(`packages/${pkg}/package.json`, ROOT), 'utf8'))
}

const firstLine = (url: URL): string => readFileSync(url, 'utf8').split(/\r?\n/, 1)[0] ?? ''

describe.each([
  ['cli', '@strutvane/cli', 'strutvane-cli'],
  ['launcher', 'strutvane', 'strutvane'],
])('packages/%s bin', (dir, name, binName) => {
  const pkg = manifest(dir)

  test('the manifest declares exactly the expected bin, as a plain dist/*.mjs path', () => {
    expect(pkg.name).toBe(name)
    expect(Object.keys(pkg.bin)).toEqual([binName])
    expect(pkg.bin[binName]).toMatch(/^dist\/[a-z][a-z0-9-]*\.mjs$/)
  })

  test('the build produces it from a source file with a shebang', () => {
    const target = pkg.bin[binName] ?? ''
    const stem = target.replace(/^dist\//, '').replace(/\.mjs$/, '')
    const entries = buildEntries(dir)
    expect(entries, `tsdown.config.ts has no build for packages/${dir}`).toBeDefined()
    expect(entries).toContain(`src/${stem}.ts`)
    const source = new URL(`packages/${dir}/src/${stem}.ts`, ROOT)
    expect(firstLine(source)).toBe('#!/usr/bin/env node')
  })

  test('when built, the dist file exists and starts with a #! line', () => {
    const built = new URL(`packages/${dir}/${pkg.bin[binName] ?? ''}`, ROOT)
    if (!existsSync(fileURLToPath(new URL(`packages/${dir}/dist`, ROOT)))) return // not built yet
    expect(existsSync(built), `${fileURLToPath(built)} is missing`).toBe(true)
    expect(statSync(built).isFile()).toBe(true)
    expect(firstLine(built)).toMatch(/^#!/)
  })
})
