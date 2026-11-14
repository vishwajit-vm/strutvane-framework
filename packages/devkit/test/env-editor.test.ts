/** `.env` + `.env.example` editing: never overwrite, never leak a secret into the example. */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createEnvEditor,
  envKeys,
  formatEnvValue,
  looksSecret,
  sectionHeader,
} from '../src/env-editor.ts'
import type { DevkitError } from '../src/errors.ts'
import { createStagedFs, type StagedFs } from '../src/staged-fs.ts'
import { readFile, rejectionOf, tempProject, writeFiles } from './helpers.ts'

let projectRoot: string
let cleanup: () => Promise<void>
let fs: StagedFs
let n = 0
const fakeSecret = () => `generated-secret-${++n}`
beforeEach(async () => {
  ;({ root: projectRoot, cleanup } = await tempProject())
  fs = createStagedFs(projectRoot)
  n = 0
})
afterEach(() => cleanup())

describe('add', () => {
  test('creates both files: secrets only in .env, defaults in both', async () => {
    const env = createEnvEditor(fs, { generateSecret: fakeSecret })
    const result = await env.ensure('Auth', [
      { key: 'AUTH_SECRET', secret: true, comment: 'Signs session cookies' },
      { key: 'AUTH_URL', value: 'http://localhost:3000' },
    ])
    expect(result).toEqual({ added: ['AUTH_SECRET', 'AUTH_URL'], kept: [] })
    await fs.commit()

    const dotenv = (await readFile(projectRoot, '.env')) ?? ''
    const example = (await readFile(projectRoot, '.env.example')) ?? ''
    expect(dotenv).toBe(
      `${sectionHeader('Auth')}\n# Signs session cookies\nAUTH_SECRET=generated-secret-1\nAUTH_URL=http://localhost:3000\n`,
    )
    expect(example).toContain('# Signs session cookies\nAUTH_SECRET=\n')
    expect(example).toContain('AUTH_URL=http://localhost:3000')
    expect(example).not.toContain('generated-secret')
  })

  test('the default secret generator is crypto-random, url-safe and 256-bit', async () => {
    await createEnvEditor(fs).add('Auth', [{ key: 'APP_SECRET', secret: true }])
    const value = /APP_SECRET=(.+)/.exec(await fs.read('.env'))?.[1] ?? ''
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await fs.read('.env.example')).toContain('APP_SECRET=\n')
  })

  test('secret-looking keys never get a value in .env.example, even when not flagged', async () => {
    const env = createEnvEditor(fs)
    await env.add('Mail', [
      { key: 'SMTP_PASSWORD', value: 'hunter2' },
      { key: 'STRIPE_API_KEY', value: 'sk_live_abc' },
      { key: 'GITHUB_TOKEN', value: 'ghp_x' },
      { key: 'SMTP_HOST', value: 'localhost' },
    ])
    const example = await fs.read('.env.example')
    for (const leaked of ['hunter2', 'sk_live_abc', 'ghp_x']) expect(example).not.toContain(leaked)
    expect(example).toContain('SMTP_PASSWORD=\n')
    expect(example).toContain('SMTP_HOST=localhost')
    expect(await fs.read('.env')).toContain('SMTP_PASSWORD=hunter2')
  })

  test('existing keys are never overwritten, in either file', async () => {
    await writeFiles(projectRoot, {
      '.env': 'DB_HOST=my-own-host\n',
      '.env.example': 'DB_HOST=documented-host\n',
    })
    const env = createEnvEditor(fs)
    const result = await env.ensure('Database', [
      { key: 'DB_HOST', value: '127.0.0.1' },
      { key: 'DB_PORT', value: '5432' },
    ])
    expect(result).toEqual({ added: ['DB_PORT'], kept: ['DB_HOST'] })
    expect(await fs.read('.env')).toBe(
      `DB_HOST=my-own-host\n\n${sectionHeader('Database')}\nDB_PORT=5432\n`,
    )
    expect(await fs.read('.env.example')).toContain('DB_HOST=documented-host')
  })

  test('is idempotent: a second identical add changes nothing', async () => {
    const env = createEnvEditor(fs, { generateSecret: fakeSecret })
    const vars = [
      { key: 'AUTH_SECRET', secret: true },
      { key: 'AUTH_URL', value: 'x' },
    ]
    await env.add('Auth', vars)
    await fs.commit()
    expect(await env.ensure('Auth', vars)).toEqual({ added: [], kept: ['AUTH_SECRET', 'AUTH_URL'] })
    expect(await fs.changes()).toEqual([])
  })

  test('new keys of an existing section go to the end of that section', async () => {
    await writeFiles(projectRoot, {
      '.env': `${sectionHeader('Auth')}\nAUTH_URL=x\n\n${sectionHeader('Mail')}\nMAIL_FROM=a@b.c\n`,
    })
    await createEnvEditor(fs).add('Auth', [{ key: 'AUTH_TRUST_HOST', value: 'true' }])
    expect(await fs.read('.env')).toBe(
      `${sectionHeader('Auth')}\nAUTH_URL=x\nAUTH_TRUST_HOST=true\n\n${sectionHeader('Mail')}\nMAIL_FROM=a@b.c\n`,
    )
  })

  test('keeps CRLF line endings, a BOM and user comments', async () => {
    await writeFiles(projectRoot, { '.env': '\uFEFF# my notes\r\nFOO=1\r\n' })
    await createEnvEditor(fs).add('Extra', [{ key: 'BAR', value: '2' }])
    expect(await fs.read('.env')).toBe(
      `\uFEFF# my notes\r\nFOO=1\r\n\r\n${sectionHeader('Extra')}\r\nBAR=2\r\n`,
    )
  })

  test('recognises export-prefixed and lower-case keys as existing', () => {
    expect([...envKeys('export FOO=1\n  bar = 2\n# BAZ=3\n')]).toEqual(['FOO', 'bar'])
  })

  test('quotes values that need it; plain values stay bare', () => {
    expect(formatEnvValue('postgres://u@h:5432/db')).toBe('postgres://u@h:5432/db')
    expect(formatEnvValue('')).toBe('')
    expect(formatEnvValue('two words')).toBe('"two words"')
    expect(formatEnvValue('say "hi" \\o/')).toBe('"say \\"hi\\" \\\\o/"')
    expect(formatEnvValue('#not-a-comment')).toBe('"#not-a-comment"')
  })

  test.each([
    [[{ key: 'lower_case', value: 'x' }], 'INVALID_ENV_KEY'],
    [[{ key: '1ABC', value: 'x' }], 'INVALID_ENV_KEY'],
    [[{ key: 'A-B', value: 'x' }], 'INVALID_ENV_KEY'],
    [[{ key: 'DUP' }, { key: 'DUP' }], 'INVALID_ENV_KEY'],
    [[{ key: 'MULTI', value: 'a\nINJECTED=1' }], 'INVALID_ENV_VALUE'],
    [[{ key: 'CR', value: 'a\rb' }], 'INVALID_ENV_VALUE'],
    [[{ key: 'S', secret: true, value: 'hard-coded' }], 'INVALID_ENV_VALUE'],
    [[{ key: 'C', comment: 'line\nINJECTED=1' }], 'INVALID_ENV_VALUE'],
  ])('rejects invalid input %j before staging anything', async (vars, code) => {
    const error = await rejectionOf(createEnvEditor(fs).add('S', vars))
    expect((error as DevkitError).code).toBe(code)
    expect(await fs.changes()).toEqual([])
  })

  test('rejects empty or multi-line section titles', async () => {
    for (const section of ['', '  ', 'A\nB']) {
      const error = await rejectionOf(createEnvEditor(fs).add(section, [{ key: 'A' }]))
      expect((error as DevkitError).code).toBe('INVALID_ENV_KEY')
    }
  })

  test('custom file paths', async () => {
    await createEnvEditor(fs, { envPath: '.env.local', examplePath: 'env.sample' }).add('X', [
      { key: 'A', value: '1' },
    ])
    expect((await fs.changes()).map((c) => c.path)).toEqual(['.env.local', 'env.sample'])
  })

  test('looksSecret', () => {
    for (const k of ['DB_PASSWORD', 'JWT_SECRET', 'API_KEY', 'APIKEY', 'SIGNING_KEY', 'KEY'])
      expect(looksSecret(k), k).toBe(true)
    for (const k of ['DB_HOST', 'PORT', 'KEYCLOAK_URL', 'MONKEY_COUNT'])
      expect(looksSecret(k), k).toBe(false)
  })

  test.each([
    // Name patterns
    ['DB_PASS', undefined, true],
    ['SMTP_PASS', undefined, true],
    ['PASS', undefined, true],
    ['DB_PWD', undefined, true],
    ['PWD', undefined, true],
    ['SENTRY_DSN', undefined, true],
    ['DSN', undefined, true],
    ['PASSWORD_SALT', undefined, true],
    ['SALT', undefined, true],
    ['HASH_SALT_ROUNDS', undefined, true],
    ['SIGNING_SECRET', undefined, true],
    ['WEBHOOK_SIGNING', undefined, true],
    ['AWS_ACCESS_KEY_ID', undefined, true],
    ['S3_ACCESS_KEY', undefined, true],
    ['GPG_PASSPHRASE', undefined, true],
    // Credentials embedded in a URL, whatever the key is called
    ['DATABASE_URL', 'postgres://app:hunter2@db:5432/app', true],
    ['REDIS_URL', 'redis://:p4ss@cache:6379', true],
    ['AMQP', 'amqps://user:pw@mq.example/vhost', true],
    // Public values
    ['DATABASE_URL', 'postgres://db:5432/app', false],
    ['DATABASE_URL', 'postgres://app@db:5432/app', false],
    ['APP_URL', 'http://localhost:3000', false],
    ['BYPASS_CACHE', 'true', false],
    ['COMPASS_URL', undefined, false],
    ['PASSENGER_COUNT', undefined, false],
    ['DSN_TIMEOUT_MS', undefined, true],
    ['SALTY_SNACKS', undefined, false],
    ['SIGNINGS_ENABLED', undefined, false],
    ['PWD_LENGTH_MIN', undefined, true],
  ])('looksSecret(%s, %j) → %s', (key, value, expected) => {
    expect(looksSecret(key, value)).toBe(expected)
  })

  test('.env.example never receives a URL with embedded credentials', async () => {
    const env = createEnvEditor(fs)
    await env.add('Database', [
      { key: 'DATABASE_URL', value: 'postgres://app:canary-pw-31@db:5432/app' },
      { key: 'DATABASE_REPLICA_URL', value: 'postgres://db-replica:5432/app' },
    ])
    const example = await fs.read('.env.example')
    expect(example).not.toContain('canary-pw-31')
    expect(example).toContain('DATABASE_URL=\n')
    expect(example).toContain('DATABASE_REPLICA_URL=postgres://db-replica:5432/app')
    expect(await fs.read('.env')).toContain('canary-pw-31') // the local file keeps the real value
  })
})

describe('remove', () => {
  test('removes keys with their comment lines and empty sections, from both files', async () => {
    const env = createEnvEditor(fs, { generateSecret: fakeSecret })
    await env.add('Base', [{ key: 'APP_NAME', value: 'demo' }])
    await env.add('Auth', [
      { key: 'AUTH_SECRET', secret: true, comment: 'Signs cookies' },
      { key: 'AUTH_URL', value: 'x' },
    ])
    await env.remove(['AUTH_SECRET', 'AUTH_URL', 'NOT_THERE'])
    expect(await fs.read('.env')).toBe(`${sectionHeader('Base')}\nAPP_NAME=demo\n`)
    expect(await fs.read('.env.example')).toBe(`${sectionHeader('Base')}\nAPP_NAME=demo\n`)
  })

  test('missing files and missing keys are ignored', async () => {
    await createEnvEditor(fs).remove(['A'])
    expect(await fs.changes()).toEqual([])
    await writeFiles(projectRoot, { '.env': 'B=1\n' })
    await createEnvEditor(fs).remove(['A'])
    expect(await fs.changes()).toEqual([])
  })
})
