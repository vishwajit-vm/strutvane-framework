/**
 * How `node strut` treats an application (`bootstrap/app.ts`): it is a project (so `.env`'s
 * `APP_ENV` reaches the production guard), its own commands (`withCommands`) are listed and run,
 * `list` is the command and `help` its alias (CONSISTENCY #13), a `BootError` is a configuration
 * failure with its hint, and every message says `node strut` (#127).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { BootError } from '../../src/foundation/boot-error.ts'
import { cli } from '../console/helpers.ts'
import {
  appFolder,
  buildApp,
  builtinsWith,
  cleanupFolders,
  sourceUrl,
  strut,
  testEnv,
  writeFiles,
  writeRealApp,
} from './helpers.ts'

afterEach(cleanupFolders)

/** A real bootstrap/app.ts with one command of its own, `reports:send`. */
function appWithCommand(root: string): void {
  writeRealApp(root)
  writeFiles(root, {
    'bootstrap/app.ts': `import { dirname } from 'node:path'
import { Application } from '${sourceUrl('foundation/application.ts')}'
import { defineConfig } from '${sourceUrl('foundation/config.ts')}'
import { defineCommand } from '${sourceUrl('console/framework/command.ts')}'

const reports = defineCommand({
  name: 'reports:send',
  description: 'Send the weekly reports',
  requiresProject: false,
  run(ctx) {
    ctx.out.success('Reports sent.')
    return { data: { sent: 3 } }
  },
})

export default Application.configure({ basePath: dirname(import.meta.dirname) })
  .withConfig({ app: defineConfig((env) => ({ key: env.string('APP_KEY') })) })
  .withCommands([reports])
  .create()
`,
  })
}

describe('an application is a project', () => {
  it('runs the commands the app registered, and lists them with their source', async () => {
    const base = appFolder()
    appWithCommand(base)
    const run = await cli(['reports:send', '--json'], { cwd: base, env: { APP_ENV: 'testing' } })
    expect(run.code).toBe(0)
    expect(run.json().data).toEqual({ sent: 3 })
    const listed = await cli(['list'], { cwd: base, env: { APP_ENV: 'testing' } })
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('reports:send')
    const help = await cli(['help', 'reports:send'], { cwd: base, env: { APP_ENV: 'testing' } })
    expect(help.stdout).toContain('Usage: node strut reports:send')
    expect(help.stdout).toContain('bootstrap/app.ts')
  })

  it('an app that cannot be imported keeps the CLI working, with a warning', async () => {
    const base = appFolder({ 'bootstrap/app.ts': 'export default 42\n' })
    const listed = await cli(['list'], { cwd: base, env: { APP_ENV: 'testing' } })
    expect(listed.code).toBe(0)
    expect(listed.stderr).toContain("The app's own commands were not loaded")
    expect(listed.stdout).toContain('route:list')
  })

  it("reads APP_ENV from the app's .env for the production guard", async () => {
    const base = appFolder({ '.env': 'APP_ENV=production\n' })
    const refused = await strut(['session:flush', '--json'], {
      cwd: base,
      env: { APP_ENV: undefined },
    })
    expect(refused.code).toBe(2)
    expect(refused.json().error?.code).toBe('production_guard')
    expect(refused.json().error?.message).toContain('`node strut session:flush` is destructive')
  })
})

describe('list and help', () => {
  it('`list` is the command; `help` and no command at all show the same listing', async () => {
    const base = appFolder()
    const options = { cwd: base, builtins: builtinsWith(() => buildApp(base).app) }
    const list = await cli(['list'], options)
    const help = await cli(['help'], options)
    const bare = await cli([], options)
    expect(list.code).toBe(0)
    expect(list.stdout).toContain('Usage: node strut <command>')
    expect(help.stdout).toBe(list.stdout)
    expect(bare.stdout).toBe(list.stdout)
  })

  it('suggestions and hints say node strut, never sv', async () => {
    const base = appFolder()
    const result = await strut(['route:lsit'], { cwd: base })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Did you mean `node strut route:list`?')
    expect(result.stderr).not.toMatch(/\bsv /)
  })
})

describe('boot errors', () => {
  it('a BootError thrown by any command is a configuration failure with its hint', async () => {
    const base = appFolder()
    const result = await strut(['route:list', '--json'], {
      cwd: base,
      app: () => {
        throw new BootError(
          'unknown_middleware',
          'No middleware is called "auht".',
          'Did you mean "auth"?',
        )
      },
    })
    expect(result.code).toBe(3)
    expect(result.json().error?.code).toBe('unknown_middleware')
    expect(result.json().data).toEqual({
      code: 'unknown_middleware',
      message: 'No middleware is called "auht".',
      hint: 'Did you mean "auth"?',
    })
  })

  it('the real loader explains a missing or wrong bootstrap/app.ts', async () => {
    const base = appFolder({ 'strut.js': '// forwarder\n' })
    writeFiles(base, { 'bootstrap/app.ts': 'export default { not: "an app" }\n' })
    const wrong = await cli(['route:list', '--json'], { cwd: base, env: { ...testEnv } })
    expect(wrong.code).toBe(3)
    expect(wrong.json().error?.code).toBe('invalid_bootstrap')
    expect(JSON.stringify(wrong.json().error)).toContain('export default Application.configure(')
  })
})
