/**
 * Logging inside an application (ADR-0022): the log manager is the app's `Logger`, built from
 * `config/logging.ts` and the app's `.env` at boot; files land in `storage/logs`; request id,
 * user id and tenant id are added to every record of a request; `Log.withContext()` is scoped to
 * the request; the exception handler reports through it; shutdown flushes it (bounded); config
 * mistakes fail the boot, `.env` mistakes only warn.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { HTTP_HOOKS, type HttpRequestHookPayload } from '../../src/contracts/http-hooks.ts'
import { HooksToken, LoggerToken } from '../../src/core/tokens.ts'
import { report } from '../../src/exceptions/report.ts'
import { Log, logger } from '../../src/facades/log.ts'
import { Application } from '../../src/foundation/application.ts'
import { isBootError } from '../../src/foundation/boot-error.ts'
import { type ConfigFiles, defineConfig } from '../../src/foundation/config.ts'
import { LoggingConfigError } from '../../src/logging/config.ts'
import { createLogManager } from '../../src/logging/manager.ts'
import { LogManagerToken } from '../../src/logging/token.ts'
import { defineRoutes, Route, type RoutesSource } from '../../src/routing/route.ts'
import { MemoryLogger } from '../app/helpers.ts'
import { testConfig, testEnv } from '../commands/helpers.ts'
import { allRecords, captureStream, type Rec } from './helpers.ts'

const roots: string[] = []
const apps: Application[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sv-app-logs-'))
  roots.push(dir)
  return dir
}

const routes: RoutesSource = defineRoutes([
  Route.get('/hello', (ctx) => {
    Log.info('in request', { path: '/hello' })
    return ctx.json({ ok: true })
  }),
  Route.get('/context', (ctx) => {
    Log.withContext({ orderId: 42 })
    Log.info('with order')
    return ctx.json({ ok: true })
  }),
  Route.get('/boom', () => {
    throw new Error('kaboom at postgres://app:hunter2@db/x')
  }),
])

interface Built {
  readonly app: Application
  readonly base: string
  readonly logs: string
  records(): Rec[]
}

function build(
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly config?: ConfigFiles
    readonly base?: string
  } = {},
): Built {
  const base = options.base ?? root()
  const app = Application.configure({ basePath: base, env: { ...testEnv, ...options.env } })
    .withConfig({ ...testConfig, ...options.config })
    .withRouting({ web: routes })
    .create()
  apps.push(app)
  const logs = join(base, 'storage', 'logs')
  return { app, base, logs, records: () => (existsSync(logs) ? allRecords(logs) : []) }
}

const byMsg = (records: readonly Rec[], msg: string): Rec | undefined =>
  records.find((r) => r.msg === msg)

describe('the app logs through its log manager', () => {
  test('LoggerToken and LogManagerToken are one manager; files land in storage/logs', async () => {
    const { app, logs, records } = build()
    await app.boot()
    const manager = app.make(LogManagerToken)
    expect(app.make(LoggerToken)).toBe(manager)
    expect(manager.config.default).toBe('stack')
    expect(manager.config.channels['stack']).toMatchObject({ leaves: ['daily'] })
    await app.run(async () => {
      Log.info('hello from a script', { invoice: 42 })
      Log.notice('a notice')
      logger('a debug line')
      expect(logger()).toBe(Log)
      await Log.flush()
    })
    const names = readdirSync(logs)
    expect(names).toEqual([expect.stringMatching(/^strutvane-\d{4}-\d{2}-\d{2}\.log$/)])
    // The default format is `line`, readable like Laravel's.
    const text = readFileSync(join(logs, names[0] ?? ''), 'utf8')
    expect(text).toMatch(
      /^\[\d{4}-\d{2}-\d{2} [\d:.]+\] testing\.INFO: hello from a script \{"invoice":42\}$/m,
    )
    expect(byMsg(records(), 'a notice')?.level).toBe('notice')
    // APP_ENV=testing logs at info by default: the debug line is not written.
    expect(byMsg(records(), 'a debug line')).toBeUndefined()
  })

  test('request id, user id and tenant id are added automatically; withContext is per request', async () => {
    const { app, records } = build()
    await app.boot()
    app.make(HooksToken).on(
      HTTP_HOOKS.request,
      (payload) => ({
        ...(payload as HttpRequestHookPayload),
        tenant: { id: 'tenant-9', strategy: 'shared' as const },
      }),
      { name: 'test.tenant' },
    )
    const actor = { id: 'user-7', type: 'user' as const }
    const first = await app.handle(new Request('http://localhost/hello'), { testing: { actor } })
    expect(first.status).toBe(200)
    await app.handle(new Request('http://localhost/context'))
    await app.handle(new Request('http://localhost/hello'))
    await app.make(LogManagerToken).flush()
    const all = records()
    const inRequest = all.filter((r) => r.msg === 'in request')
    expect(inRequest).toHaveLength(2)
    const [withActor, withoutActor] = inRequest
    expect(withActor).toMatchObject({ actorId: 'user-7', tenantId: 'tenant-9' })
    expect(withActor?.requestId).toEqual(expect.any(String))
    expect(withActor?.requestId).toBe(withActor?.traceId)
    expect(withoutActor?.['actorId']).toBeUndefined()
    expect(withoutActor?.requestId).not.toBe(withActor?.requestId)
    // withContext() reached the record of its own request only.
    expect(byMsg(all, 'with order')?.fields).toMatchObject({ orderId: 42 })
    expect(withoutActor?.fields?.['orderId']).toBeUndefined()
  })

  test('the exception handler reports through it, redacted, with the request id', async () => {
    const { app, records } = build()
    const response = await app.handle(new Request('http://localhost/boom'))
    expect(response.status).toBe(500)
    await app.make(LogManagerToken).flush()
    const reported = byMsg(records(), 'Unhandled error while serving a request')
    expect(reported?.level).toBe('error')
    expect(reported?.requestId).toEqual(expect.any(String))
    expect(JSON.stringify(reported)).not.toContain('hunter2')
    expect(JSON.stringify(reported)).toContain('kaboom')
  })

  test('report(error) and Log.report go to the log; never throw for the error itself', async () => {
    const { app, records } = build()
    await app.boot()
    await app.run(async () => {
      report(new Error('handled failure'))
      app.make(LogManagerToken).report('a thrown string', { job: 'sync' })
      await Log.flush()
    })
    const all = records()
    expect(JSON.stringify(byMsg(all, 'Unhandled error'))).toContain('handled failure')
    expect(byMsg(all, 'a thrown string')).toMatchObject({ level: 'error', fields: { job: 'sync' } })
  })

  test('shutdown drains the queue (bounded) and later calls are ignored', async () => {
    const { app, records } = build()
    await app.boot()
    app.run(() => {
      for (let i = 0; i < 500; i++) Log.info(`queued ${i}`)
    })
    // No flush: shutdown alone must write everything queued.
    const report = await app.shutdown()
    expect(report.timedOut).toBe(false)
    const all = records()
    expect(all.filter((r) => String(r.msg).startsWith('queued '))).toHaveLength(500)
  })

  test('a test can still swap LoggerToken for a memory logger', async () => {
    const { app, logs } = build()
    const memory = new MemoryLogger()
    app.container.value(LoggerToken, memory)
    await app.boot()
    app.run(() => {
      Log.critical('to memory')
      Log.notice('also to memory')
      Log.warning('warned')
      Log.alert('alerted')
      Log.emergency('down')
      expect(Log.isLevelEnabled('notice')).toBe(true)
      expect(Log.isLevelEnabled('nonsense' as never)).toBe(false)
    })
    expect(memory.messages('fatal')).toEqual(['to memory', 'alerted', 'down'])
    expect(memory.messages('info')).toEqual(['also to memory'])
    expect(memory.messages('warn')).toEqual(['warned'])
    expect(existsSync(logs)).toBe(false)
  })
})

describe('config/logging.ts and .env', () => {
  const channels: ConfigFiles = {
    logging: defineConfig(() => ({
      channels: {
        payments: { driver: 'daily' as const, name: 'payments', level: 'info' as const },
        audit: { driver: 'stack' as const, channels: ['daily', 'payments'] },
      },
    })),
  }

  test('named channels, stacks, on-demand channels and shared context', async () => {
    const { app, logs } = build({ config: channels })
    await app.boot()
    await app.run(async () => {
      Log.shareContext({ release: '2026.11.17' })
      Log.channel('payments').info('paid', { invoice: 1 })
      Log.stack(['payments', 'daily']).warning('both')
      Log.channel('audit').error('audited')
      Log.build({ driver: 'single', path: 'storage/logs/imports', name: 'imports' }).info('import')
      Log.channel('nope').info('to the default channel')
      expect(Log.sharedContext()).toEqual({ release: '2026.11.17' })
      Log.flushSharedContext()
      Log.withContext({ ambient: true }).info('ambient')
      Log.withoutContext().info('plain')
      Log.deprecation('nobody reads this')
      Log.log('notice', 'by name')
      Log.log('loud' as never, 'unknown level')
      expect(Log.manager()).toBe(app.make(LogManagerToken))
      expect(Log.child({ module: 'billing' })).toBeDefined()
      await Log.flush()
    })
    const names = readdirSync(logs).sort()
    expect(names).toEqual([
      'imports',
      expect.stringMatching(/^payments-\d{4}-\d{2}-\d{2}\.log$/),
      expect.stringMatching(/^strutvane-\d{4}-\d{2}-\d{2}\.log$/),
    ])
    const payments = allRecords(logs).filter((r) => r.msg !== undefined)
    expect(byMsg(payments, 'paid')?.fields).toEqual({ release: '2026.11.17', invoice: 1 })
    expect(payments.filter((r) => r.msg === 'both')).toHaveLength(2)
    expect(payments.filter((r) => r.msg === 'audited')).toHaveLength(2)
    expect(byMsg(payments, 'to the default channel')).toBeDefined()
    expect(payments.some((r) => String(r.msg).includes('channel "nope" is not defined'))).toBe(true)
    expect(byMsg(payments, 'ambient')?.fields).toEqual({ ambient: true })
    expect(byMsg(payments, 'plain')?.fields).toBeUndefined()
    expect(byMsg(payments, 'nobody reads this')).toBeUndefined()
    expect(byMsg(payments, 'unknown level')).toMatchObject({
      level: 'error',
      fields: { invalidLevel: 'loud' },
    })
    expect(allRecords(join(logs, 'imports')).map((r) => r.msg)).toEqual(['import'])
  })

  test('LOG_CHANNEL, LOG_LEVEL and LOG_FORMAT come from the app environment', async () => {
    const { app, logs, records } = build({
      env: { LOG_CHANNEL: 'single', LOG_LEVEL: 'debug', LOG_FORMAT: 'json' },
    })
    await app.boot()
    await app.run(async () => {
      Log.debug('debug is on')
      await Log.flush()
    })
    expect(readdirSync(logs)).toEqual(['strutvane.log'])
    expect(readFileSync(join(logs, 'strutvane.log'), 'utf8')).toMatch(/^\{"time":/)
    expect(byMsg(records(), 'debug is on')?.level).toBe('debug')
  })

  test('LOG_CHANNEL=null writes nothing', async () => {
    const { app, logs } = build({ env: { LOG_CHANNEL: 'null' } })
    await app.boot()
    await app.run(async () => {
      Log.error('discarded')
      await Log.flush()
    })
    expect(existsSync(logs)).toBe(false)
  })

  test('a .env mistake never fails the boot: the default is used and one warning is logged', async () => {
    const { app, records } = build({ env: { LOG_LEVEL: 'loud', LOG_PATH: '../../../etc' } })
    await app.boot()
    const manager = app.make(LogManagerToken)
    expect(manager.issues.map((issue) => issue.key).sort()).toEqual(['LOG_LEVEL', 'LOG_PATH'])
    await manager.flush()
    const warnings = records().filter((r) => r.level === 'warning')
    expect(warnings.some((r) => String(r.msg).includes('LOG_PATH'))).toBe(true)
    expect(app.loggingConfig().issues).toHaveLength(2)
  })

  test('a config/logging.ts mistake fails the boot with every problem and a hint', async () => {
    const bad = (value: unknown): ConfigFiles => ({ logging: defineConfig(() => value) })
    for (const [value, re] of [
      [{ channels: { audit: { driver: 'stack', channels: ['audit'] } } }, /loops/],
      [{ channels: { x: { driver: 'daily', path: '../../outside' } } }, /climbs out/],
      [{ channels: { x: { driver: 'daily', name: '../x' } } }, /can't be a file name/],
      [{ channels: { x: { driver: 'custom' } } }, /via/],
      ['daily', /must export an object/],
      [{ channels: ['daily'] }, /channels must be an object/],
    ] as const) {
      const { app } = build({ config: bad(value) })
      const error = await app.boot().catch((e: unknown) => e)
      expect(isBootError(error), String(error)).toBe(true)
      expect((error as Error & { code: string }).code).toBe('invalid_logging_config')
      expect((error as Error).message).toMatch(re)
    }
    const { app } = build({ config: bad({ channels: { x: { driver: 'nope' } } }) })
    expect(() => app.loggingConfig()).toThrow(/is unknown/)
  })

  test('Log.build refuses a path outside the project', async () => {
    const { app } = build()
    await app.boot()
    app.run(() => {
      expect(() => Log.build({ driver: 'single', path: '../../escape' })).toThrow(
        LoggingConfigError,
      )
    })
  })

  test('an absolute LOG_PATH is honoured, Windows paths included', async () => {
    const outside = root()
    const { app } = build({ env: { LOG_PATH: outside, LOG_CHANNEL: 'single' } })
    await app.boot()
    await app.run(async () => {
      Log.info('outside the project')
      await Log.flush()
    })
    expect(readdirSync(outside)).toEqual(['strutvane.log'])
    expect(app.loggingConfig().config.path).toBe(outside)
  })
})

describe('the facade with a manager bound by hand', () => {
  test('every level, alias and helper reaches the manager', async () => {
    const out = captureStream()
    const manager = createLogManager({
      env: { LOG_CHANNEL: 'stdout', LOG_FORMAT: 'json', LOG_LEVEL: 'debug' },
      streams: { stdout: out.stream },
    })
    const { app } = build()
    app.container.value(LogManagerToken, manager)
    app.container.value(LoggerToken, manager)
    await app.run(async () => {
      for (const m of [
        'emergency',
        'alert',
        'critical',
        'error',
        'warning',
        'notice',
        'info',
        'debug',
        'trace',
        'warn',
        'fatal',
      ] as const)
        Log[m](m)
      expect(Log.isLevelEnabled('debug')).toBe(true)
      expect(Log.logger()).toBe(manager)
      await Log.flush()
    })
    expect(
      out
        .lines()
        .map((r) => r.level)
        .slice(0, 11),
    ).toEqual([
      'emergency',
      'alert',
      'critical',
      'error',
      'warning',
      'notice',
      'info',
      'debug',
      'debug',
      'warning',
      'critical',
    ])
    await manager.close()
  })

  test('outside an app the facade says how to get one', () => {
    expect(() => Log.info('x')).toThrow(/Log\.info\(\) was called outside a request/)
    expect(() => Log.channel('daily')).toThrow(/Log\.channel\(\)/)
  })
})
