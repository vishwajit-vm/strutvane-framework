/** `strutvane.config.ts` patching with magicast: comments survive, unknown shapes are refused. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createConfigPatcher, providerLocalName } from '../src/config-patcher.ts'
import type { DevkitError } from '../src/errors.ts'
import { createStagedFs, type StagedFs } from '../src/staged-fs.ts'
import { rejectionOf, tempProject, writeFiles } from './helpers.ts'

const CONFIG = `// Strutvane project configuration. Edited by hand AND by \`sv add\`.
import { defineConfig } from '@strutvane/core'
import backend from '@strutvane/framework/provider'

export default defineConfig({
  name: 'acme', // the app name
  /* Service providers, in boot order. */
  providers: [
    backend,
  ],
})
`

let projectRoot: string
let cleanup: () => Promise<void>
let fs: StagedFs
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  fs = createStagedFs(projectRoot)
})
afterEach(() => cleanup())

const config = () => fs.read('strutvane.config.ts')

describe('registerProvider', () => {
  test('adds the import after the last import and the provider at the end; comments survive', async () => {
    await writeFiles(projectRoot, { 'strutvane.config.ts': CONFIG })
    await createConfigPatcher(fs).registerProvider('@strutvane/auth/provider')
    const code = await config()
    expect(code).toBe(
      CONFIG.replace(
        "import backend from '@strutvane/framework/provider'\n",
        "import backend from '@strutvane/framework/provider'\nimport authProvider from '@strutvane/auth/provider'\n",
      ).replace('    backend,\n', '    backend,\n    authProvider,\n'),
    )
  })

  test('is idempotent', async () => {
    await writeFiles(projectRoot, { 'strutvane.config.ts': CONFIG })
    const patcher = createConfigPatcher(fs)
    await patcher.registerProvider('@strutvane/auth/provider')
    const once = await config()
    await patcher.registerProvider('@strutvane/auth/provider')
    expect(await config()).toBe(once)
  })

  test('re-lists a provider whose import exists but which is missing from the array', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `import auth from '@strutvane/auth/provider'\nexport default { providers: [] }\n`,
    })
    await createConfigPatcher(fs).registerProvider('@strutvane/auth/provider')
    const code = await config()
    expect(code.match(/import auth from/g)).toHaveLength(1)
    expect(code).toMatch(/providers: \[\s*auth\s*\]/)
  })

  test('creates the providers array in a plain object export and follows double quotes + semicolons', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `import { x } from "y";\n\nexport default { name: "demo" };\n`,
    })
    await createConfigPatcher(fs).registerProvider('@strutvane/logs/provider')
    const code = await config()
    expect(code).toContain(
      `import { x } from "y";\nimport logsProvider from "@strutvane/logs/provider";\n`,
    )
    expect(code).toMatch(/providers: \[\s*logsProvider\s*\]/)
  })

  test('works with no imports at all, placing the import before the first statement', async () => {
    await writeFiles(projectRoot, { 'strutvane.config.ts': `export default { providers: [] }\n` })
    await createConfigPatcher(fs).registerProvider('./app/providers/billing.provider.ts')
    const code = await config()
    expect(
      code.startsWith(`import billingProvider from './app/providers/billing.provider.ts'`),
    ).toBe(true)
  })

  test('picks a unique local name when the derived one is taken', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `import authProvider from './mine.ts'\nconst authProvider2 = 1\nexport default { providers: [authProvider] }\n`,
    })
    await createConfigPatcher(fs).registerProvider('@strutvane/auth/provider')
    const code = await config()
    expect(code).toContain(`import authProvider3 from '@strutvane/auth/provider'`)
    expect(code).toMatch(/providers: \[authProvider, authProvider3\]/)
  })

  test.each([
    ['no default export', `export const config = {}\n`],
    ['a default export that is not an object', `export default 42\n`],
    ['a computed default export', `const c = make()\nexport default c\n`],
    ['providers that is not an array literal', `export default { providers: list }\n`],
    ['a file that does not parse', `export default {{{\n`],
  ])('refuses %s and never writes', async (_, source) => {
    await writeFiles(projectRoot, { 'strutvane.config.ts': source })
    const error = await rejectionOf(
      createConfigPatcher(fs).registerProvider('@strutvane/auth/provider'),
    )
    expect((error as DevkitError).code).toBe('CONFIG_SHAPE_UNRECOGNISED')
    expect(await fs.changes()).toEqual([])
  })

  test('a missing config file is CONFIG_NOT_FOUND', async () => {
    const error = await rejectionOf(
      createConfigPatcher(fs).registerProvider('@strutvane/auth/provider'),
    )
    expect((error as DevkitError).code).toBe('CONFIG_NOT_FOUND')
  })

  test.each(["x'; process.exit(1); '", '@scope/../../etc', 'https://evil.example/provider.js', ''])(
    'rejects the unsafe module specifier %j (no code injection)',
    async (specifier) => {
      await writeFiles(projectRoot, { 'strutvane.config.ts': CONFIG })
      const error = await rejectionOf(createConfigPatcher(fs).registerProvider(specifier))
      expect((error as DevkitError).code).toBe('INVALID_PATH')
      expect(await fs.changes()).toEqual([])
    },
  )

  test('custom config path', async () => {
    await writeFiles(projectRoot, { 'config/app.ts': `export default { providers: [] }\n` })
    await createConfigPatcher(fs, { path: 'config/app.ts' }).registerProvider(
      '@strutvane/ui/provider',
    )
    expect(await fs.read('config/app.ts')).toContain('uiProvider')
  })
})

describe('layouts: the file keeps its own style (register → unregister round trip)', () => {
  const SPEC = '@strutvane/auth/provider'
  test.each([
    [
      'multi-line without trailing comma',
      `import a from 'a'\nexport default { providers: [\n  a\n] }\n`,
      `import a from 'a'\nimport authProvider from '@strutvane/auth/provider'\nexport default { providers: [\n  a,\n  authProvider\n] }\n`,
    ],
    [
      'trailing line comment after the last item',
      `import a from 'a'\nexport default {\n  providers: [\n    a, // core\n  ],\n}\n`,
      `import a from 'a'\nimport authProvider from '@strutvane/auth/provider'\nexport default {\n  providers: [\n    a, // core\n    authProvider,\n  ],\n}\n`,
    ],
    [
      'inline array',
      `import a from 'a'\nexport default { providers: [a] }\n`,
      `import a from 'a'\nimport authProvider from '@strutvane/auth/provider'\nexport default { providers: [a, authProvider] }\n`,
    ],
    [
      'satisfies wrapper',
      `import a from 'a'\nexport default { providers: [a] } satisfies Config\n`,
      `import a from 'a'\nimport authProvider from '@strutvane/auth/provider'\nexport default { providers: [a, authProvider] } satisfies Config\n`,
    ],
    [
      'CRLF line endings',
      `import a from 'a'\r\nexport default {\r\n  providers: [\r\n    a,\r\n  ],\r\n}\r\n`,
      `import a from 'a'\r\nimport authProvider from '@strutvane/auth/provider'\r\nexport default {\r\n  providers: [\r\n    a,\r\n    authProvider,\r\n  ],\r\n}\r\n`,
    ],
    [
      'a byte-order mark',
      `﻿import a from 'a'\nexport default { providers: [a] }\n`,
      `﻿import a from 'a'\nimport authProvider from '@strutvane/auth/provider'\nexport default { providers: [a, authProvider] }\n`,
    ],
    [
      'a quoted "providers" key',
      `import a from 'a'\nexport default { 'providers': [a] }\n`,
      `import a from 'a'\nimport authProvider from '@strutvane/auth/provider'\nexport default { 'providers': [a, authProvider] }\n`,
    ],
  ])('%s', async (_, source, expected) => {
    await writeFiles(projectRoot, { 'strutvane.config.ts': source })
    const patcher = createConfigPatcher(fs)
    await patcher.registerProvider(SPEC)
    expect(await config()).toBe(expected)
    await patcher.unregisterProvider(SPEC)
    expect(await config()).toBe(source)
  })

  test('an empty array with a comment keeps the comment', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `export default { providers: [/* none yet */] }\n`,
    })
    await createConfigPatcher(fs).registerProvider(SPEC)
    expect(await config()).toContain('[/* none yet */ authProvider ]')
  })

  test('an empty object gets a providers key', async () => {
    await writeFiles(projectRoot, { 'strutvane.config.ts': `export default defineConfig({})\n` })
    await createConfigPatcher(fs).registerProvider(SPEC)
    expect(await config()).toContain('defineConfig({ providers: [authProvider] })')
  })

  test('a multi-line object without providers gets one on a new line', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `export default {\n  name: 'x',\n}\n`,
    })
    await createConfigPatcher(fs).registerProvider(SPEC)
    expect(await config()).toContain(`  name: 'x',\n  providers: [authProvider],\n}`)
  })

  test('removes a middle item from an inline array', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `import a from 'a'\nimport auth from '@strutvane/auth/provider'\nimport b from 'b'\nexport default { providers: [a, auth, b] }\n`,
    })
    await createConfigPatcher(fs).unregisterProvider(SPEC)
    expect(await config()).toBe(
      `import a from 'a'\nimport b from 'b'\nexport default { providers: [a, b] }\n`,
    )
  })

  test('keeps an import that also brings in other names', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `import auth, { helper } from '@strutvane/auth/provider'\nexport default { providers: [auth], extra: helper }\n`,
    })
    await createConfigPatcher(fs).unregisterProvider(SPEC)
    const code = await config()
    expect(code).toContain(`import auth, { helper } from '@strutvane/auth/provider'`)
    expect(code).toContain('providers: []')
  })

  test('removes an import that shares its line with other code', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `import auth from '@strutvane/auth/provider'; export default { providers: [auth] }\n`,
    })
    await createConfigPatcher(fs).unregisterProvider(SPEC)
    expect(await config()).toBe(' export default { providers: [] }\n')
  })
})

describe('unregisterProvider', () => {
  test('round-trip: register then unregister restores the original file byte for byte', async () => {
    await writeFiles(projectRoot, { 'strutvane.config.ts': CONFIG })
    const patcher = createConfigPatcher(fs)
    await patcher.registerProvider('@strutvane/auth/provider')
    await patcher.unregisterProvider('@strutvane/auth/provider')
    expect(await config()).toBe(CONFIG)
    expect(await fs.changes()).toEqual([])
  })

  test('missing file or provider is a no-op', async () => {
    const patcher = createConfigPatcher(fs)
    await patcher.unregisterProvider('@strutvane/auth/provider')
    await writeFiles(projectRoot, { 'strutvane.config.ts': CONFIG })
    await patcher.unregisterProvider('@strutvane/auth/provider')
    expect(await fs.changes()).toEqual([])
  })

  test('removes the import even when providers has no array', async () => {
    await writeFiles(projectRoot, {
      'strutvane.config.ts': `import auth from '@strutvane/auth/provider'\nexport default { name: 'x' }\n`,
    })
    await createConfigPatcher(fs).unregisterProvider('@strutvane/auth/provider')
    expect(await config()).not.toContain('@strutvane/auth/provider')
  })
})

test.each([
  ['@strutvane/auth/provider', 'authProvider'],
  ['@strutvane/logs', 'logsProvider'],
  ['./app/providers/billing.provider.ts', 'billingProvider'],
  ['../shared/my-cool-thing.ts', 'myCoolThingProvider'],
  ['@acme/123-tools/provider', 'p123ToolsProvider'],
  ['provider', 'providerProvider'],
])('providerLocalName(%s) = %s', (specifier, expected) => {
  expect(providerLocalName(specifier)).toBe(expected)
})
