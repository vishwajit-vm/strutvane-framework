/**
 * Boot validation (packaging audit boot matrix): a malformed setting stops `sv start` / `sv dev`
 * with exit 3 and a friendly "Invalid environment" message naming the key, before anything boots.
 * Before, these booted with a broken value (a timezone or locale no formatter accepts, an API
 * prefix without its slash, a CORS "origin" that is a path, an empty TRUST_PROXY read as 0) or
 * exited 1 with a driver error (a SQLite file in a folder that does not exist).
 *
 * The class covered: every framework-read setting a generated `.env` feeds, each malformed and
 * empty, through `bootProject` and the CLI's failure mapping.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toFailure } from '../../src/console/framework/errors.ts'
import { EXIT } from '../../src/console/framework/exit-codes.ts'
import { renderMessages } from '../../src/console/framework/run.ts'
import { EnvValidationError } from '../../src/core/index.ts'
import { frameworkProvider } from '../../src/provider.ts'
import { bootProject } from '../../src/runtime/boot.ts'
import { validateBootSettings } from '../../src/runtime/boot-validation.ts'
import type { LoadedProject } from '../../src/runtime/project.ts'

const KEYS = [
  'APP_TIMEZONE',
  'APP_LOCALE',
  'API_PREFIX',
  'CORS_ORIGINS',
  'TRUST_PROXY',
  'DB_DATABASE',
  'APP_URL',
]
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sv-bootval-'))
  await mkdir(join(root, 'storage'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A project as config/*.ts would load it from a generated .env. */
function project(config: Record<string, Record<string, unknown>> = {}): LoadedProject {
  return {
    root,
    config: {
      ...config,
      app: { env: 'local', timezone: 'UTC', locale: 'en', trustProxy: 0, ...config['app'], root },
      api: { prefix: '/api', version: 'v1', ...config['api'] },
      cors: { origins: ['http://localhost:3000'], ...config['cors'] },
      database: {
        default: 'sqlite',
        connection: { filename: 'storage/database.sqlite' },
        ...config['database'],
      },
    },
    providers: [frameworkProvider({ database: { driver: 'sqlite', url: ':memory:' }, models: [] })],
    models: [],
    resources: [],
    routes: [],
  }
}

async function bootError(p: LoadedProject): Promise<EnvValidationError> {
  const error = await bootProject(p).then(
    async (booted) => {
      await booted.shutdown()
      return undefined
    },
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(EnvValidationError)
  return error as EnvValidationError
}

describe('boot validation: malformed settings stop the boot with the key named', () => {
  it.each([
    ['APP_TIMEZONE', { app: { timezone: '%%not-valid%%' } }],
    ['APP_TIMEZONE', { app: { timezone: '' } }],
    ['APP_TIMEZONE', { app: { timezone: 'Mars/Olympus' } }],
    ['APP_LOCALE', { app: { locale: '%%not-valid%%' } }],
    ['APP_LOCALE', { app: { locale: '' } }],
    ['API_PREFIX', { api: { prefix: 'api' } }],
    ['API_PREFIX', { api: { prefix: '%%not-valid%%' } }],
    ['API_PREFIX', { api: { prefix: '' } }],
    ['CORS_ORIGINS', { cors: { origins: ['%%not-valid%%'] } }],
    ['CORS_ORIGINS', { cors: { origins: ['https://app.example.com/path'] } }],
    ['CORS_ORIGINS', { cors: { origins: ['*'] } }],
    ['CORS_ORIGINS', { cors: { origins: 'https://a.example' } }],
    ['TRUST_PROXY', { app: { trustProxy: -1 } }],
    ['TRUST_PROXY', { app: { trustProxy: 'yes' } }],
    ['APP_URL', { app: { publicUrl: '%%not-valid%%' } }],
    ['DB_DATABASE', { database: { connection: { filename: 'no/such/folder/db.sqlite' } } }],
    ['DB_DATABASE', { database: { connection: { filename: 'storage' } } }],
  ] as const)('%s: %j', async (key, config) => {
    const error = await bootError(project(config as Record<string, Record<string, unknown>>))
    expect(error.problems.map((p) => p.key)).toContain(key)
    // Never the value itself (it could be a secret); always what to do.
    expect(error.message).not.toContain('%%not-valid%%')
    const failure = toFailure(error)
    expect(failure).toMatchObject({
      code: 'env_invalid',
      exitCode: EXIT.VALIDATION,
      unexpected: false,
    })
    const { message } = renderMessages(failure)
    expect(message).toMatch(/^Invalid environment/)
  })

  it('an empty TRUST_PROXY in the environment is refused (it used to read as 0)', async () => {
    process.env['TRUST_PROXY'] = ''
    const error = await bootError(project())
    expect(error.problems.map((p) => p.key)).toEqual(['TRUST_PROXY'])
  })

  it('lists every problem at once', async () => {
    const error = await bootError(
      project({ app: { timezone: 'x', locale: '!!' }, api: { prefix: 'v' } }),
    )
    expect(error.problems.map((p) => p.key).sort()).toEqual([
      'API_PREFIX',
      'APP_LOCALE',
      'APP_TIMEZONE',
    ])
  })

  it('valid settings boot, including unset optional ones', async () => {
    const booted = await bootProject(
      project({
        app: {
          timezone: 'Asia/Kolkata',
          locale: 'pt-BR',
          trustProxy: 1,
          publicUrl: 'https://app.example.com',
        },
        cors: { origins: ['https://app.example.com', 'http://localhost:5173'] },
      }),
    )
    await booted.shutdown()
    expect(validateBootSettings({ root, config: {} })).toEqual([])
  })
})
