/** Secret env files: recognised everywhere, and their values never shown in a diff by default. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createEnvEditor } from '../../src/devkit/env-editor.ts'
import { defineInstaller, runInstaller } from '../../src/devkit/installer.ts'
import { renderUpgradePreview } from '../../src/devkit/merge/upgrade.ts'
import {
  isSecretEnvFile,
  REDACTED,
  redactEnvLine,
  unifiedPatch,
} from '../../src/devkit/secret-files.ts'
import { createStagedFs } from '../../src/devkit/staged-fs.ts'
import { readFile, tempProject, writeFiles } from './helpers.ts'

/** Distinctive values that must never appear in diff output. */
const CANARIES = [
  'canary-existing-token-7f3a',
  'canary-db-password-91c2',
  'canary-continuation-55d0',
  'canary-local-only-0b8e',
]

let projectRoot: string
let cleanup: () => Promise<void>
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
})
afterEach(() => cleanup())

describe('isSecretEnvFile', () => {
  test.each([
    ['.env', true],
    ['.env.local', true],
    ['.env.production', true],
    ['apps/web/.env', true],
    ['config/.env.test.local', true],
    ['.ENV', true],
    ['.env.example', false],
    ['apps/web/.env.example', false],
    ['.envrc', false],
    ['env.ts', false],
    ['src/.environment.ts', false],
    ['README.md', false],
  ])('%s → %s', (path, expected) => {
    expect(isSecretEnvFile(path)).toBe(expected)
  })
})

describe('redactEnvLine', () => {
  test.each([
    ['API_TOKEN=abc', `API_TOKEN=${REDACTED}`],
    ['export DB_URL = "postgres://u:p@h/db"', `export DB_URL =${REDACTED}`],
    ['EMPTY=', `EMPTY=${REDACTED}`],
    ['A=1\r', `A=${REDACTED}\r`],
    ['# a comment stays', '# a comment stays'],
    ['   ', '   '],
    ['', ''],
    ['continuation of a multi-line value', REDACTED],
    ['not an assignment: secret', REDACTED],
  ])('%j → %j', (line, expected) => {
    expect(redactEnvLine(line)).toBe(expected)
  })
})

describe('unifiedPatch', () => {
  test('without redaction it matches a plain unified diff', () => {
    const patch = unifiedPatch('a/x.ts', 'b/x.ts', 'a\nb\n', 'a\nc\n', { redact: false })
    expect(patch).toContain('-b\n+c\n')
  })

  test('redaction keeps headers, hunk counts and the "no newline" marker', () => {
    const patch = unifiedPatch('a/.env', 'b/.env', 'A=1\nB=old', 'A=1\nB=new', { redact: true })
    expect(patch).toContain('--- a/.env')
    expect(patch).toContain('@@ -1,2 +1,2 @@')
    expect(patch).toContain(` A=${REDACTED}\n-B=${REDACTED}\n\\ No newline at end of file`)
    expect(patch).not.toMatch(/B=old|B=new/)
  })
})

describe('StagedFs.diff redacts secret env files', () => {
  const existingEnv = [
    '# ─── Database',
    `DATABASE_URL=postgres://app:${CANARIES[1]}@db:5432/app`,
    `EXISTING_TOKEN=${CANARIES[0]}`,
    `MULTI="first line`,
    `${CANARIES[2]}"`,
    'APP_NAME=demo',
    '',
  ].join('\n')

  test('a canary never appears: generated secrets, context, removed and multi-line values', async () => {
    await writeFiles(projectRoot, { '.env': existingEnv, '.env.example': 'APP_NAME=demo\n' })
    const fs = createStagedFs(projectRoot)
    await createEnvEditor(fs).add('Auth', [
      { key: 'AUTH_SECRET', secret: true },
      { key: 'AUTH_URL', value: 'http://localhost:3000' },
    ])
    await fs.write('.env.local', `LOCAL_ONLY=${CANARIES[3]}\n`)
    const generated = /AUTH_SECRET=(\S+)/.exec(await fs.read('.env'))?.[1] ?? ''
    expect(generated.length).toBeGreaterThan(20)

    const diff = await fs.diff()
    for (const canary of [...CANARIES, generated]) expect(diff).not.toContain(canary)
    expect(diff).toContain(`+AUTH_SECRET=${REDACTED}`)
    expect(diff).toContain(` EXISTING_TOKEN=${REDACTED}`)
    expect(diff).toContain(`+LOCAL_ONLY=${REDACTED}`)
    expect(diff).toContain('+# ─── Auth') // comments and section headers stay readable
    // .env.example holds no secrets by design, so its diff stays readable.
    expect(diff).toContain('+AUTH_URL=http://localhost:3000')
    expect(diff).toContain('+++ b/.env.example')

    // Deleting the file must not print it either.
    fs.discard()
    await fs.remove('.env')
    const deletion = await fs.diff()
    expect(deletion).toContain('+++ /dev/null')
    for (const canary of CANARIES) expect(deletion).not.toContain(canary)
  })

  test('revealSecrets: true is the explicit opt-out', async () => {
    await writeFiles(projectRoot, { '.env': existingEnv })
    const fs = createStagedFs(projectRoot)
    await fs.write('.env', `${existingEnv}NEW=${CANARIES[3]}\n`, { overwrite: true })
    expect(await fs.diff({ revealSecrets: true })).toContain(CANARIES[3])
    expect(await fs.diff({ revealSecrets: false })).not.toContain(CANARIES[3])
  })

  test('CRLF env files are redacted line for line', async () => {
    await writeFiles(projectRoot, { '.env': `A=${CANARIES[0]}\r\n` })
    const fs = createStagedFs(projectRoot)
    await fs.write('.env', `A=${CANARIES[1]}\r\n`, { overwrite: true })
    const diff = await fs.diff()
    expect(diff).toContain(`-A=${REDACTED}\r\n+A=${REDACTED}\r\n`)
    for (const canary of CANARIES) expect(diff).not.toContain(canary)
  })
})

describe('installer and upgrade previews', () => {
  const installer = defineInstaller({
    name: 'canary',
    async install({ env }) {
      await env.add('Canary', [
        { key: 'CANARY_SECRET', secret: true },
        { key: 'CANARY_DSN', value: `https://key:${CANARIES[1]}@sentry.example/1` },
      ])
    },
    async uninstall({ env }) {
      await env.remove(['CANARY_SECRET', 'CANARY_DSN'])
    },
  })

  test('install, dry run and uninstall results never carry a secret in their diff', async () => {
    await writeFiles(projectRoot, { '.env': `EXISTING_TOKEN=${CANARIES[0]}\n` })
    const dry = await runInstaller(installer, { projectRoot, dryRun: true })
    for (const canary of CANARIES) expect(dry.diff).not.toContain(canary)

    const installed = await runInstaller(installer, { projectRoot })
    const generated = /CANARY_SECRET=(\S+)/.exec((await readFile(projectRoot, '.env')) ?? '')?.[1]
    expect(generated).toBeDefined()
    for (const canary of [...CANARIES, generated ?? '']) {
      expect(installed.diff).not.toContain(canary)
    }
    // The credential URL never reached the committed example either.
    expect(await readFile(projectRoot, '.env.example')).not.toContain(CANARIES[1])

    const removed = await runInstaller(installer, { projectRoot, mode: 'uninstall' })
    expect(removed.diff).toContain(`-CANARY_SECRET=${REDACTED}`)
    for (const canary of [...CANARIES, generated ?? '']) {
      expect(removed.diff).not.toContain(canary)
    }
  })

  test('renderUpgradePreview redacts a secret env file too', () => {
    const preview = renderUpgradePreview({
      lockStatus: 'ok',
      notes: [],
      items: [
        {
          lockKey: 'config/.env.defaults',
          path: 'config/.env.defaults',
          template: 't',
          version: '1.0.0',
          mode: 'three-way',
          action: 'update',
          before: `A=${CANARIES[0]}\n`,
          after: `A=${CANARIES[1]}\n`,
          newBase: '',
          conflicts: [],
          notes: [],
        },
      ],
    } as unknown as Parameters<typeof renderUpgradePreview>[0])
    expect(preview).toContain(`+A=${REDACTED}`)
    for (const canary of CANARIES) expect(preview).not.toContain(canary)
  })
})
