/**
 * `sv env:check` and `sv key:generate` (docs/09 §2).
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createEnvEditor, createStagedFs } from '../../devkit/index.ts'
import { type AnyCommand, defineCommand } from '../framework/command.ts'
import { CliError, usageError } from '../framework/errors.ts'
import { EXIT } from '../framework/exit-codes.ts'
import { checkEnv, isValidEnvName } from '../project/env-check.ts'
import { readEnvFile } from '../project/env-file.ts'

export const envCheckCommand: AnyCommand = defineCommand({
  name: 'env:check',
  description: 'Compare .env with .env.example: missing, unknown, empty and invalid keys',
  details: [
    'Exits 3 when there are errors: a documented key is missing, a line is invalid, or a',
    'secret-looking key has a value in .env.example. Values are never printed, and malformed',
    'lines are reported by file and line number only.',
  ].join('\n'),
  flags: {
    strict: { type: 'boolean', description: 'Treat unknown and empty keys as errors' },
  },
  examples: ['sv env:check', 'sv env:check --env test --strict', 'sv env:check --json'],
  run(ctx) {
    const root = ctx.requireProject().root
    const envName = ctx.globals.env
    if (envName !== undefined && !isValidEnvName(envName)) {
      throw usageError('INVALID_ARGUMENT', {
        detail: `--env "${envName}" must be a plain name like "test".`,
      })
    }
    const result = checkEnv(root, { envName, strict: ctx.flags.strict === true })
    if (!result.exampleExists) {
      throw new CliError('ENV_EXAMPLE_MISSING', {
        exitCode: EXIT.VALIDATION,
        params: { path: result.exampleFile },
      })
    }
    const { out } = ctx
    for (const p of result.problems) {
      const tag = p.severity === 'error' ? out.style.red('error  ') : out.style.yellow('warning')
      out.line(`${tag} ${p.message}`)
    }
    const errors = result.problems.filter((p) => p.severity === 'error')
    if (errors.length > 0) {
      throw new CliError('ENV_PROBLEMS', {
        exitCode: EXIT.VALIDATION,
        params: { count: errors.length },
        data: result,
      })
    }
    out.success(
      result.problems.length === 0
        ? `${result.envFiles.join(' + ')} matches ${result.exampleFile}.`
        : `No errors (${result.problems.length} warning(s)).`,
    )
    return { data: result }
  },
})

/**
 * Every `APP_KEY=` line of an env file (group 1: everything before the value), `export` prefixes
 * included. A byte-order mark may precede the first line: the env reader skips it, so this must
 * too, or a forced replacement of a first-line key would report success and change nothing.
 */
const APP_KEY_LINE = /^(\uFEFF?[ \t]*(?:export[ \t]+)?APP_KEY[ \t]*=).*$/gm

/** A new application key: 32 random bytes, base64url (the same format devkit uses for secrets). */
export function generateAppKey(): string {
  return randomBytes(32).toString('base64url')
}

export const keyGenerateCommand: AnyCommand = defineCommand({
  name: 'key:generate',
  description: 'Generate APP_KEY into .env (and document it in .env.example)',
  details: [
    'The key encrypts cookies, sessions and encrypted fields. It is written only to .env, which is',
    'never committed; .env.example gets an empty APP_KEY= entry. The key is never printed unless',
    '--show is passed (and then nothing is written).',
    'Replacing a non-empty key needs --force; unless APP_ENV is local, test, testing or',
    'development it also needs --i-understand. Every APP_KEY line in .env is replaced.',
  ].join('\n'),
  // --show works anywhere; writing calls requireProject().
  requiresProject: false,
  flags: {
    show: { type: 'boolean', description: 'Print a new key instead of writing it' },
  },
  examples: ['sv key:generate', 'sv key:generate --force', 'sv key:generate --show'],
  async run(ctx) {
    const { out } = ctx
    const key = generateAppKey()
    if (ctx.flags.show === true) {
      if (out.json) return { data: { key, written: false } }
      out.raw(key)
      return { data: { key, written: false } }
    }
    const root = ctx.requireProject().root
    const existing = readEnvFile(join(root, '.env'))
    const current = existing?.entries.get('APP_KEY')
    // Every APP_KEY line counts (a duplicate earlier in the file may hold the real key).
    const replacesKey = existing?.all.some((e) => e.key === 'APP_KEY' && e.value !== '') === true
    if (replacesKey) {
      if (!ctx.globals.force) {
        throw new CliError('KEY_EXISTS', { exitCode: EXIT.CONFLICT, params: { path: '.env' } })
      }
      // Replacing a key makes existing sessions and encrypted data unreadable: outside local,
      // test and development environments that needs --force --i-understand.
      ctx.guardDestructive()
    }
    const fs = createStagedFs(root)
    if (current !== undefined) {
      // Replace every existing APP_KEY line in place (empty, or forced), keeping the layout, so no
      // stale duplicate is left behind for a later loader to pick up.
      const text = await fs.read('.env')
      const replaced = text.replace(APP_KEY_LINE, `$1${key}`)
      await fs.write('.env', replaced, { overwrite: true })
    }
    const env = createEnvEditor(fs, { generateSecret: () => key })
    await env.ensure('Application', [
      { key: 'APP_KEY', secret: true, comment: 'Encryption key. Generate with: sv key:generate' },
    ])
    const changes = await fs.changes()
    const files = changes.map((c) => c.path)
    if (ctx.globals.dryRun) {
      // The diff would contain the key itself, so only file names are shown.
      fs.discard()
      for (const file of files) out.line(`  would update ${file}`)
      return { data: { written: false, dryRun: true, files } }
    }
    await fs.commit()
    out.success(
      `APP_KEY written to .env${files.includes('.env.example') ? ' (and documented in .env.example)' : ''}.`,
    )
    if (replacesKey) {
      out.warn(
        'The previous key was replaced: existing sessions and encrypted values can no longer be read.',
      )
    }
    return { data: { written: true, dryRun: false, files } }
  },
})
