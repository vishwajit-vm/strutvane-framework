/**
 * Small bugs the docs agent found in 0.2.0-next.1 (each test fails on that version):
 * - `node strut start` / `dev` refused `--force-debug`, the flag the `debug_in_production` hint names;
 * - a 415 answered literally "Send the request body as {expected}.";
 * - `route:list` printed `throttle:60:1` where routes (and `--security`) say `throttle:60,1`;
 * - schema, migration and sandbox errors lost their hint and printed "Unexpected error".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { commands } from '../../src/commands.ts'
import { toFailure } from '../../src/console/framework/errors.ts'
import { renderMessages } from '../../src/console/framework/run.ts'
import { MigrationError } from '../../src/migrations/migration-error.ts'
import { SandboxError } from '../../src/migrations/sandbox.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { startApplication } from '../../src/runtime/server.ts'
import { SchemaError } from '../../src/schema/errors.ts'
import { appFolder, buildApp, cleanupFolders, strut } from './helpers.ts'

afterEach(cleanupFolders)

describe('--force-debug on start and dev', () => {
  it('both commands accept the flag', () => {
    for (const name of ['start', 'dev']) {
      const command = commands.find((candidate) => candidate.name === name)
      expect(command?.flags, name).toHaveProperty('force-debug')
    }
  })

  it('startApplication refuses APP_DEBUG in production unless forced', async () => {
    const base = appFolder()
    const load = async () =>
      buildApp(base, { env: { APP_ENV: 'production', APP_DEBUG: 'true' } }).app
    await expect(startApplication({ root: base, port: 0, load })).rejects.toMatchObject({
      code: 'debug_in_production',
    })
    const started = await startApplication({ root: base, port: 0, load, forceDebug: true })
    try {
      expect(started.app.environment).toBe('production')
      expect(started.app.showsDebugDetails).toBe(false)
    } finally {
      await started.stop()
    }
  })
})

describe('415 names the media type it wants', () => {
  it('a JSON body sent as text/plain', async () => {
    const base = appFolder()
    const { app } = buildApp(base, {
      web: defineRoutes([Route.post('/echo', async (ctx) => ctx.json(await ctx.body()))]),
    })
    const response = await app.handle(
      new Request('http://localhost/echo', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', accept: 'application/json' },
        body: '{}',
      }),
      { testing: { withoutCsrf: true } },
    )
    expect(response.status).toBe(415)
    const problem = (await response.json()) as { detail?: string }
    expect(problem.detail).toBe('Send the request body as application/json.')
    expect(problem.detail).not.toContain('{expected}')
  })
})

describe('route:list', () => {
  it('prints middleware parameters the way routes write them', async () => {
    const base = appFolder()
    const web = defineRoutes([
      Route.get('/limited', (ctx) => ctx.json({ ok: true }))
        .name('limited')
        .middleware('throttle:60,1'),
    ])
    const result = await strut(['route:list', '--json'], {
      cwd: base,
      app: () => buildApp(base, { web }).app,
    })
    expect(result.code, result.stderr).toBe(0)
    const routes = (result.json().data as { routes: { name: string; middleware: string[] }[] })
      .routes
    const limited = routes.find((route) => route.name === 'limited')
    expect(limited?.middleware).toContain('throttle:60,1')
    expect(limited?.middleware).not.toContain('throttle:60:1')
  })
})

describe('migration errors keep their hint in the CLI', () => {
  it.each([
    [
      'SchemaError',
      Object.assign(
        new SchemaError('unknown_table', 'There is no table "post".', 'Did you mean "posts"?'),
        { migration: '2026_01_01_000000_create_posts_table.ts' },
      ),
    ],
    [
      'SandboxError',
      new SandboxError('migration_syntax', 'Unexpected token.', 'Fix the syntax error.', {
        location: 'database/migrations/x.ts:3:7',
      }),
    ],
    [
      'MigrationError',
      new MigrationError('migration_failed', 'The ALTER failed.', 'Fix the column and re-run.'),
    ],
  ])('%s', (_name, error) => {
    const failure = toFailure(error)
    expect(failure.unexpected).toBe(false)
    expect(failure.code).toBe(error.code)
    const { message } = renderMessages(failure)
    expect(message).not.toMatch(/Unexpected error/)
    expect(message).toContain(error.message)
    expect(message).toContain(error.hint)
    expect(failure.data).toEqual({ code: error.code, message: error.message, hint: error.hint })
  })

  it('a migration error is a failure, a bad migration file is invalid input', () => {
    expect(toFailure(new MigrationError('migration_failed', 'x', 'y')).exitCode).not.toBe(
      toFailure(new SchemaError('unknown_table', 'x', 'y')).exitCode,
    )
    expect(
      renderMessages(
        toFailure(
          new SandboxError('replay_timeout', 'Slow.', 'Raise it.', {
            migration: 'm.ts',
          }),
        ),
      ).message,
    ).toContain('m.ts: Slow.')
  })
})
