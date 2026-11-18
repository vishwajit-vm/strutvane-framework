/**
 * `strutvane.compat`, the range of CLI versions a package accepts. Release blocker found by the
 * skeleton's integration test (2026-11-18): 0.2.0-next.0 still declared `^0.1.0-next.0`, so its own
 * CLI refused `migrate`, `db:seed`, `sync`, `start` and `dev` in a 0.2 app. These tests make that
 * class of mistake fail here, at every future version bump, instead of in an app:
 *
 * - the framework's own manifest must accept its own version and the whole release train;
 * - the advice the CLI gives plugin authors is derived from the CLI's version, never hard-coded;
 * - the package that *is* the running CLI is never refused by itself.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { toFailure } from '../../src/console/framework/errors.ts'
import { renderMessages } from '../../src/console/framework/run.ts'
import { assertCompatible, checkCompat } from '../../src/console/project/contributions.ts'
import type { InstalledPackage } from '../../src/console/project/project.ts'
import { compatRangeFor, parseVersion, satisfies } from '../../src/console/project/semver.ts'
import { CLI_PACKAGE, CLI_VERSION } from '../../src/console/version.ts'

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string; strutvane: { compat: string } }

/** The package as another CLI copy would see it (not exempt as "itself"). */
const asPlugin = (compat: string | undefined, version = manifest.version): InstalledPackage => ({
  name: 'strutvane-plugin-example',
  version,
  dir: '.',
  manifest: compat === undefined ? {} : { strutvane: { compat } },
})

describe("the framework's own strutvane.compat", () => {
  const { version } = manifest
  const range = manifest.strutvane.compat
  const parsed = parseVersion(version)

  test('package.json names the CLI package and a valid version', () => {
    expect(manifest.name).toBe(CLI_PACKAGE)
    expect(parsed).toBeDefined()
    expect(CLI_VERSION).toBe(version)
  })

  test(`accepts the package's own version (${version})`, () => {
    // Exactly the check the CLI runs on every package's range.
    expect(checkCompat(asPlugin(range), version)).toEqual({ ok: true })
    expect(satisfies(version, range, { includePrerelease: true })).toBe(true)
  })

  test('accepts the whole release train: its prereleases, the release and later patches', () => {
    if (parsed === undefined) throw new Error('unreachable')
    const train = parsed.major === 0 ? `0.${parsed.minor}` : `${parsed.major}.${parsed.minor}`
    for (const candidate of [`${train}.0`, `${train}.9`])
      expect(satisfies(candidate, range, { includePrerelease: true }), candidate).toBe(true)
    if (parsed.prerelease.length > 0) {
      const tag = String(parsed.prerelease[0])
      expect(satisfies(`${train}.0-${tag}.99`, range, { includePrerelease: true })).toBe(true)
    }
  })

  test('does not claim the next train (0.x minors break; core packages share a train)', () => {
    if (parsed === undefined) throw new Error('unreachable')
    const next = parsed.major === 0 ? `0.${parsed.minor + 1}.0` : `${parsed.major + 1}.0.0`
    expect(satisfies(next, range, { includePrerelease: true })).toBe(false)
  })
})

describe('compatRangeFor: the range a package of this train should declare', () => {
  test.each([
    ['0.2.0-next.0', '^0.2.0-next.0'],
    ['0.2.0-next.7', '^0.2.0-next.0'],
    ['0.2.3', '^0.2.0'],
    ['0.0.4', '^0.0.0'],
    ['1.4.2', '^1.0.0'],
    ['2.0.0-rc.1', '^2.0.0-rc.0'],
    ['1.0.0-1', '^1.0.0-0'],
  ])('%s → %s', (version, expected) => {
    expect(compatRangeFor(version)).toBe(expected)
  })

  test('the suggested range always accepts the version it was made for', () => {
    for (const version of ['0.1.0-next.3', '0.2.0-next.0', '0.2.5', '1.0.0', '3.1.4-beta.2'])
      expect(satisfies(version, compatRangeFor(version) ?? '', { includePrerelease: true })).toBe(
        true,
      )
  })

  test('invalid versions get no suggestion', () => {
    expect(compatRangeFor('next')).toBeUndefined()
  })
})

describe('checkCompat', () => {
  test('the running CLI is never refused by itself, whatever its manifest says', () => {
    const self: InstalledPackage = {
      name: CLI_PACKAGE,
      version: '0.2.0-next.0',
      dir: '.',
      manifest: { strutvane: { compat: '^0.1.0-next.0' } },
    }
    expect(checkCompat(self, '0.2.0-next.0')).toEqual({ ok: true })
    // Another version of the framework is checked like any package.
    expect(checkCompat({ ...self, version: '0.1.0-next.4' }, '0.2.0-next.0')).toMatchObject({
      ok: false,
      range: '^0.1.0-next.0',
    })
  })

  test("a plugin without a range is refused; the hint suggests this CLI's train", () => {
    let thrown: unknown
    try {
      assertCompatible(asPlugin(undefined), '0.2.0-next.4')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'missing_compat' })
    const { hint } = renderMessages(toFailure(thrown))
    expect(hint).toContain('"compat": "^0.2.0-next.0"')
    expect(hint).not.toContain('0.1')
  })
})
