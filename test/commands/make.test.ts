/**
 * The app generators `make:command`, `make:rule` and `make:observer`: where they write, the names
 * they derive, the universal flags (`--dry-run`, `--diff`, `--force`, idempotent re-runs), bad
 * input, and the generated files type-checking against the framework under strict settings.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appFolder, cleanupFolders, ROOT, strut, writeFiles } from './helpers.ts'

afterEach(cleanupFolders)

const read = (base: string, path: string): string => readFileSync(join(base, path), 'utf8')

describe('make:command', () => {
  it('writes app/console/commands/<name>.command.ts with a default app: name', async () => {
    const base = appFolder()
    const result = await strut(['make:command', 'SendReportsCommand', '--json'], { cwd: base })
    expect(result.code).toBe(0)
    expect(result.json().data).toEqual({
      path: 'app/console/commands/send-reports.command.ts',
      action: 'create',
      dryRun: false,
      command: 'app:send-reports',
    })
    const file = read(base, 'app/console/commands/send-reports.command.ts')
    expect(file).toContain('export const sendReportsCommand = defineCommand({')
    expect(file).toContain("name: 'app:send-reports'")
    expect(file).toContain("examples: ['node strut app:send-reports']")
    const text = await strut(['make:command', 'Other', '--command=reports:send'], { cwd: base })
    expect(text.stdout).toContain(
      'Next: register it in bootstrap/app.ts with .withCommands([otherCommand])',
    )
  })

  it('refuses an invalid command name and an invalid class name', async () => {
    const base = appFolder()
    const badCommand = await strut(['make:command', 'Send', '--command=Reports Send', '--json'], {
      cwd: base,
    })
    expect(badCommand.code).toBe(2)
    expect(badCommand.json().error?.code).toBe('invalid_command_name')
    const badName = await strut(['make:command', '../escape', '--json'], { cwd: base })
    expect(badName.code).not.toBe(0)
    expect(existsSync(join(base, 'app'))).toBe(false)
  })
})

describe('make:rule and make:observer', () => {
  it('writes a zod rule and an observer typed against the model when it exists', async () => {
    const base = appFolder({
      'app/models/post.ts': 'export interface Post { readonly id: number }\n',
    })
    const rule = await strut(['make:rule', 'UppercaseRule', '--json'], { cwd: base })
    expect(rule.json().data).toMatchObject({
      path: 'app/rules/uppercase.rule.ts',
      action: 'create',
    })
    expect(read(base, 'app/rules/uppercase.rule.ts')).toContain('export const uppercaseRule = z')
    const observer = await strut(['make:observer', 'PostObserver', '--json'], { cwd: base })
    expect(observer.json().data).toMatchObject({
      path: 'app/observers/post.observer.ts',
      model: 'Post',
      modelFound: true,
    })
    const file = read(base, 'app/observers/post.observer.ts')
    expect(file).toContain("import type { Post } from '../models/post.ts'")
    for (const method of ['created', 'updated', 'deleted', 'restored', 'forceDeleted'])
      expect(file).toContain(`  ${method}(post: Post)`)
    const audit = await strut(['make:observer', 'Audit', '--model=Invoice', '--json'], {
      cwd: base,
    })
    expect(audit.json().data).toMatchObject({ model: 'Invoice', modelFound: false })
    expect(read(base, 'app/observers/audit.observer.ts')).toContain('type Invoice = object')
  })

  it('--dry-run writes nothing, a second run changes nothing, --force replaces with --diff', async () => {
    const base = appFolder()
    const dry = await strut(['make:rule', 'Slug', '--dry-run', '--json'], { cwd: base })
    expect(dry.json().data).toMatchObject({ dryRun: true, action: 'create' })
    expect(existsSync(join(base, 'app', 'rules', 'slug.rule.ts'))).toBe(false)
    await strut(['make:rule', 'Slug'], { cwd: base })
    const again = await strut(['make:rule', 'Slug', '--json'], { cwd: base })
    expect(again.json().data).toMatchObject({ action: 'unchanged' })
    writeFileSync(join(base, 'app', 'rules', 'slug.rule.ts'), '// mine\n')
    const refused = await strut(['make:rule', 'Slug', '--json'], { cwd: base })
    expect(refused.code).toBe(4)
    expect(refused.json().error?.code).toBe('file_exists')
    expect(read(base, 'app/rules/slug.rule.ts')).toBe('// mine\n')
    const forced = await strut(['make:rule', 'Slug', '--force', '--diff'], { cwd: base })
    expect(forced.code).toBe(0)
    expect(forced.stdout).toContain('-// mine')
    expect(read(base, 'app/rules/slug.rule.ts')).toContain('export const slugRule')
  })

  it('the generated files type-check under the framework strict settings', async () => {
    const base = appFolder({
      'app/models/post.ts': 'export interface Post { readonly id: number }\n',
    })
    await strut(['make:command', 'SendReports'], { cwd: base })
    await strut(['make:rule', 'Uppercase'], { cwd: base })
    await strut(['make:observer', 'PostObserver'], { cwd: base })
    await strut(['make:observer', 'Audit', '--model=Invoice'], { cwd: base })
    writeFiles(base, {
      // Generated apps are ES modules.
      'package.json': '{ "type": "module" }',
      'tsconfig.json': JSON.stringify({
        extends: join(ROOT, 'tsconfig.base.json').replaceAll('\\', '/'),
        compilerOptions: {
          noEmit: true,
          // App settings: apps don't set isolatedDeclarations or declaration (they are for
          // publishing libraries; registry-typecheck.test.ts does the same). This check used to pass
          // only because the framework sources failed under `types: []`, and tsc skips declaration
          // diagnostics (TS9010) when there are semantic errors; once the sources compiled cleanly
          // in this setup (fix/release-0.2), the library-only rule surfaced on the generated files.
          isolatedDeclarations: false,
          declaration: false,
          declarationMap: false,
          types: [],
          typeRoots: [join(ROOT, 'node_modules', '@types').replaceAll('\\', '/')],
          lib: ['ES2024', 'DOM'],
          paths: {
            '@strutvane/framework/console': [join(ROOT, 'src', 'console', 'index.ts')],
            zod: [join(ROOT, 'node_modules', 'zod', 'index.d.cts')],
          },
        },
        include: ['app/**/*.ts'],
      }),
    })
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
    let output = ''
    try {
      execFileSync(process.execPath, [tsc, '-p', join(base, 'tsconfig.json')], {
        encoding: 'utf8',
        cwd: base,
      })
    } catch (error) {
      output = String((error as { stdout?: unknown }).stdout ?? error)
    }
    // Only the generated files matter here: errors inside the framework source are its own gate.
    const own = output.split('\n').filter((line) => line.startsWith('app/'))
    expect(own).toEqual([])
  }, 120_000)
})
