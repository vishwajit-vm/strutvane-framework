/**
 * `createAppPatcher` / `context.app`: the edits every add-on installer made by hand (health,
 * log-viewer, search, social-login and redis each shipped their own copy) to a v2 app's
 * `bootstrap/providers.ts` and `config/index.ts`. Idempotent, reversible byte for byte, and
 * fail-safe: an unfamiliar file is never touched, the installer prints what to add instead.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAppPatcher } from '../../src/devkit/app-patcher.ts'
import type { DevkitError } from '../../src/devkit/errors.ts'
import { defineInstaller, runInstaller } from '../../src/devkit/installer.ts'
import { createStagedFs, type StagedFs } from '../../src/devkit/staged-fs.ts'
import { rejectionOf, tempProject, writeFiles } from './helpers.ts'

/** The skeleton's files (strutvane-skeleton template, v2/skeleton). */
const PROVIDERS = `// The service providers that run at boot, in order (Laravel's bootstrap/providers.php).
import type { AnyProvider } from '@strutvane/framework'
import { AppServiceProvider } from '../app/providers/app.provider.ts'

const providers: readonly AnyProvider[] = [AppServiceProvider]

export default providers
`
const CONFIG_INDEX = `// Every defineConfig file, keyed by file name.
import type { ConfigFiles } from '@strutvane/framework'
import app from './app.ts'
import cache from './cache.ts'

export default { app, cache } satisfies ConfigFiles
`
const HEALTH = { specifier: '@strutvane/health/provider', name: 'HealthServiceProvider' }
const HEALTH_CONFIG = { specifier: './health.ts', name: 'health' }

let projectRoot: string
let cleanup: () => Promise<void>
let fs: StagedFs
const warnings: string[] = []
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  fs = createStagedFs(projectRoot)
  warnings.length = 0
})
afterEach(() => cleanup())

const patcher = () => createAppPatcher(fs, { log: { warn: (message) => warnings.push(message) } })

describe('bootstrap/providers.ts', () => {
  test('adds a named import after the last import and appends the provider; idempotent', async () => {
    await writeFiles(projectRoot, { 'bootstrap/providers.ts': PROVIDERS })
    expect((await patcher().addProvider(HEALTH)).status).toBe('added')
    const code = await fs.read('bootstrap/providers.ts')
    expect(code).toBe(
      PROVIDERS.replace(
        "import { AppServiceProvider } from '../app/providers/app.provider.ts'\n",
        "import { AppServiceProvider } from '../app/providers/app.provider.ts'\nimport { HealthServiceProvider } from '@strutvane/health/provider'\n",
      ).replace('[AppServiceProvider]', '[AppServiceProvider, HealthServiceProvider]'),
    )
    expect((await patcher().addProvider(HEALTH)).status).toBe('unchanged')
    expect(await fs.read('bootstrap/providers.ts')).toBe(code)
  })

  test('remove undoes add byte for byte (CRLF and a multi-line list too)', async () => {
    const multiline = PROVIDERS.replace(
      '[AppServiceProvider]',
      '[\n  AppServiceProvider,\n]',
    ).replace(/\n/g, '\r\n')
    await writeFiles(projectRoot, { 'bootstrap/providers.ts': multiline })
    await patcher().addProvider(HEALTH)
    const added = await fs.read('bootstrap/providers.ts')
    expect(added).toContain('  AppServiceProvider,\r\n  HealthServiceProvider,\r\n]')
    expect((await patcher().removeProvider(HEALTH)).status).toBe('removed')
    expect(await fs.read('bootstrap/providers.ts')).toBe(multiline)
    expect((await patcher().removeProvider(HEALTH)).status).toBe('unchanged')
  })

  test('also edits `export default [...] satisfies …` and `export const providers`', async () => {
    await writeFiles(projectRoot, {
      'bootstrap/providers.ts':
        "import { A } from './a.ts'\n\nexport default [A] satisfies readonly unknown[]\n",
    })
    await patcher().addProvider(HEALTH)
    expect(await fs.read('bootstrap/providers.ts')).toContain(
      'export default [A, HealthServiceProvider] satisfies',
    )
    await writeFiles(projectRoot, {
      'bootstrap/providers.ts': 'export const providers = []\n',
    })
    fs = createStagedFs(projectRoot)
    await patcher().addProvider(HEALTH)
    expect(await fs.read('bootstrap/providers.ts')).toBe(
      "import { HealthServiceProvider } from '@strutvane/health/provider'\n\nexport const providers = [HealthServiceProvider]\n",
    )
  })

  test('an unfamiliar file is left alone and the manual lines are printed', async () => {
    const odd = "import { base } from './base.ts'\n\nexport default [...base]\n"
    await writeFiles(projectRoot, { 'bootstrap/providers.ts': odd })
    const result = await patcher().addProvider(HEALTH)
    expect(result.status).toBe('manual')
    expect(result.manual).toEqual([
      "import { HealthServiceProvider } from '@strutvane/health/provider'",
      'add HealthServiceProvider to the providers list in bootstrap/providers.ts',
    ])
    expect(await fs.read('bootstrap/providers.ts')).toBe(odd)
    expect(warnings[0]).toContain('bootstrap/providers.ts was not changed')
    expect(warnings[0]).toContain(
      "import { HealthServiceProvider } from '@strutvane/health/provider'",
    )
  })

  test('a missing file, a broken file and a name already taken are manual too', async () => {
    expect((await patcher().addProvider(HEALTH)).status).toBe('manual')
    await writeFiles(projectRoot, { 'bootstrap/providers.ts': 'const providers = [\n' })
    fs = createStagedFs(projectRoot)
    expect((await patcher().addProvider(HEALTH)).status).toBe('manual')
    await writeFiles(projectRoot, {
      'bootstrap/providers.ts':
        "import { HealthServiceProvider } from './mine.ts'\n\nconst providers = []\nexport default providers\n",
    })
    fs = createStagedFs(projectRoot)
    const taken = await patcher().addProvider(HEALTH)
    expect(taken.status).toBe('manual')
    expect(warnings.at(-1)).toContain('already means something else')
  })

  test('removal never breaks an import that also brings other names', async () => {
    const shared =
      "import { HealthServiceProvider, healthCheck } from '@strutvane/health/provider'\n\nconst providers = [HealthServiceProvider]\nexport default providers\n"
    await writeFiles(projectRoot, { 'bootstrap/providers.ts': shared })
    expect((await patcher().removeProvider(HEALTH)).status).toBe('manual')
    expect(await fs.read('bootstrap/providers.ts')).toBe(shared)
  })

  test('refuses specifiers and names that would inject code', async () => {
    const bad = (await rejectionOf(
      patcher().addProvider({ specifier: "x'; process.exit(1); '", name: 'X' }),
    )) as DevkitError
    expect(bad.code).toBe('invalid_path')
    const badName = (await rejectionOf(
      patcher().addProvider({ specifier: '@strutvane/health/provider', name: 'a b' }),
    )) as DevkitError
    expect(badName.code).toBe('invalid_path')
  })
})

describe('config/index.ts', () => {
  test('adds a default import and a shorthand property; remove restores the file', async () => {
    await writeFiles(projectRoot, { 'config/index.ts': CONFIG_INDEX })
    expect((await patcher().addConfig(HEALTH_CONFIG)).status).toBe('added')
    const code = await fs.read('config/index.ts')
    expect(code).toContain("import cache from './cache.ts'\nimport health from './health.ts'\n")
    expect(code).toContain('export default { app, cache, health } satisfies ConfigFiles')
    expect((await patcher().addConfig(HEALTH_CONFIG)).status).toBe('unchanged')
    expect((await patcher().removeConfig(HEALTH_CONFIG)).status).toBe('removed')
    expect(await fs.read('config/index.ts')).toBe(CONFIG_INDEX)
  })

  test('a config built some other way is manual', async () => {
    const built = "import app from './app.ts'\n\nconst all = { app }\nexport default all\n"
    await writeFiles(projectRoot, { 'config/index.ts': built })
    const result = await patcher().addConfig(HEALTH_CONFIG)
    expect(result.status).toBe('manual')
    expect(result.manual[0]).toBe("import health from './health.ts'")
    expect(await fs.read('config/index.ts')).toBe(built)
  })
})

describe('in an installer (context.app)', () => {
  test('install then uninstall leaves both files as they were', async () => {
    await writeFiles(projectRoot, {
      'bootstrap/providers.ts': PROVIDERS,
      'config/index.ts': CONFIG_INDEX,
    })
    const installer = defineInstaller({
      name: 'health',
      async install(context) {
        await context.app.addProvider(HEALTH)
        await context.app.addConfig(HEALTH_CONFIG)
      },
      async uninstall(context) {
        await context.app.removeConfig(HEALTH_CONFIG)
        await context.app.removeProvider(HEALTH)
      },
    })
    await runInstaller(installer, { projectRoot })
    const installed = createStagedFs(projectRoot)
    expect(await installed.read('bootstrap/providers.ts')).toContain('HealthServiceProvider]')
    expect(await installed.read('config/index.ts')).toContain('health }')
    await runInstaller(installer, { projectRoot, mode: 'uninstall' })
    const after = createStagedFs(projectRoot)
    expect(await after.read('bootstrap/providers.ts')).toBe(PROVIDERS)
    expect(await after.read('config/index.ts')).toBe(CONFIG_INDEX)
  })

  test('an unfamiliar file does not fail the install: the warning is in the log', async () => {
    await writeFiles(projectRoot, { 'bootstrap/providers.ts': 'export default [...base]\n' })
    const installer = defineInstaller({
      name: 'health',
      async install(context) {
        await context.app.addProvider(HEALTH)
      },
    })
    const result = await runInstaller(installer, { projectRoot })
    expect(result.messages.some((message) => message.level === 'warn')).toBe(true)
  })
})
