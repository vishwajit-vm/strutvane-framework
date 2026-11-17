/**
 * `node strut env:encrypt` / `env:decrypt`: commit an encrypted `.env.production` and decrypt it
 * at deploy time, Laravel's commands of the same name.
 *
 * ```
 * node strut env:encrypt --env production            # prints a new key once
 * STRUT_ENV_KEY=base64:… node strut env:decrypt --env production
 * ```
 *
 * - AES-256-GCM (`security/aead.ts`, full 16-byte tags only) with a 32-byte key from
 *   `STRUT_ENV_KEY` or `--key`. Prefer the variable: a `--key` on the command line lands in shell
 *   history and process lists.
 * - Without a key, `env:encrypt` generates one and prints it once. **The key is never written to
 *   disk**: keep it in your secrets manager or CI secrets.
 * - A wrong key, a changed file or a truncated tag writes nothing.
 * - `--env <name>` (the CLI's global flag) picks `.env.<name>`; the name is checked by the CLI, so
 *   it can't climb out of the app folder. `--force` replaces an existing output file; replacing a
 *   decrypted file outside local and testing environments also needs `--i-understand`.
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DecryptError, openSealed, packSealed, seal, unpackSealed } from '../../../security/aead.ts'
import { writeFileAtomic } from '../../../support/atomic-write.ts'
import type { AnyCommand, CommandContext } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import { appRoot, commandError, defineAppCommand } from './support.ts'

/** The first line of an encrypted env file: format and version. */
const HEADER = 'STRUTVANE-ENV-1'
/** Authenticated data binding the ciphertext to this use. */
const AAD = 'strutvane:env-file'
/** The variable the key is read from. */
const KEY_VARIABLE = 'STRUT_ENV_KEY'
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Parse an env-encryption key: `base64:` and exactly 32 bytes. Never echoes the value.
 *
 * @example
 * parseEnvKey(`base64:${randomBytes(32).toString('base64')}`) // Buffer(32)
 */
export function parseEnvKey(value: string): Buffer {
  const encoded = value.startsWith('base64:') ? value.slice('base64:'.length) : ''
  const bytes = BASE64.test(encoded) ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
  if (bytes.length !== 32 || bytes.toString('base64') !== encoded)
    throw commandError(
      'invalid_env_key',
      'The encryption key must be "base64:" followed by 32 bytes in base64.',
      'Run node strut env:encrypt without a key to generate one.',
      EXIT.USAGE,
    )
  return bytes
}

/** `.env` or `.env.<name>` inside the app. */
function envFile(ctx: CommandContext): { readonly path: string; readonly label: string } {
  const label = ctx.globals.env === undefined ? '.env' : `.env.${ctx.globals.env}`
  return { path: join(appRoot(ctx), label), label }
}

function keyFrom(ctx: CommandContext, flag: string | undefined): string | undefined {
  const fromEnv = ctx.services.env[KEY_VARIABLE]
  return flag ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv)
}

const KEY_FLAG = {
  key: {
    type: 'string',
    valueName: '<base64:…>',
    description: `The key; prefer the ${KEY_VARIABLE} variable (a flag lands in shell history)`,
  },
} as const

/**
 * The `env:encrypt` and `env:decrypt` commands.
 *
 * @example
 * envCryptCommands()
 */
export function envCryptCommands(): readonly AnyCommand[] {
  return [
    defineAppCommand({
      name: 'env:encrypt',
      description: 'Encrypt .env (or .env.<name> with --env) into a file you can commit',
      details: `The key comes from ${KEY_VARIABLE} or --key; without one, a new key is generated and printed once. It is never written to disk.`,
      requiresProject: false,
      flags: KEY_FLAG,
      examples: [
        'node strut env:encrypt --env production',
        `${KEY_VARIABLE}=base64:… node strut env:encrypt --env production --force`,
      ],
      run(ctx) {
        const source = envFile(ctx)
        if (!existsSync(source.path))
          throw commandError(
            'no_env_file',
            `${source.label} does not exist.`,
            'Create it first, then encrypt it.',
            EXIT.VALIDATION,
          )
        const target = `${source.path}.encrypted`
        if (existsSync(target) && !ctx.globals.force)
          throw commandError(
            'file_exists',
            `${source.label}.encrypted already exists, so nothing was written.`,
            'Add --force to replace it.',
            EXIT.CONFLICT,
          )
        const given = keyFrom(ctx, ctx.flags.key)
        const keyText = given ?? `base64:${randomBytes(32).toString('base64')}`
        const sealed = seal(parseEnvKey(keyText), readFileSync(source.path), AAD)
        writeFileAtomic(target, `${HEADER}\n${packSealed(sealed).toString('base64')}\n`)
        ctx.out.success(`Encrypted ${source.label} into ${source.label}.encrypted.`)
        if (given === undefined) {
          ctx.out.line()
          ctx.out.line(
            '  Decryption key (shown once, never saved; keep it in your secrets manager or CI secrets):',
          )
          ctx.out.line(`  ${keyText}`)
        }
        return {
          data: {
            file: `${source.label}.encrypted`,
            ...(given === undefined ? { generatedKey: keyText } : {}),
          },
        }
      },
    }),
    defineAppCommand({
      name: 'env:decrypt',
      description: 'Decrypt .env.encrypted (or .env.<name>.encrypted with --env)',
      details: `The key comes from ${KEY_VARIABLE} (preferred) or --key. A wrong key or a changed file writes nothing.`,
      requiresProject: false,
      flags: KEY_FLAG,
      examples: [
        `${KEY_VARIABLE}=base64:… node strut env:decrypt --env production`,
        'node strut env:decrypt --env production --force',
      ],
      run(ctx) {
        const target = envFile(ctx)
        const source = `${target.path}.encrypted`
        if (!existsSync(source))
          throw commandError(
            'no_encrypted_file',
            `${target.label}.encrypted does not exist.`,
            'Encrypt it first with node strut env:encrypt.',
            EXIT.VALIDATION,
          )
        const keyText = keyFrom(ctx, ctx.flags.key)
        if (keyText === undefined)
          throw commandError(
            'no_env_key',
            'No decryption key was given.',
            `Set ${KEY_VARIABLE} (preferred) or pass --key=base64:….`,
            EXIT.USAGE,
          )
        const key = parseEnvKey(keyText)
        if (existsSync(target.path)) {
          if (!ctx.globals.force)
            throw commandError(
              'file_exists',
              `${target.label} already exists, so nothing was written.`,
              'Add --force to replace it.',
              EXIT.CONFLICT,
            )
          // Replacing a live env file is destructive outside local and testing.
          ctx.guardDestructive()
        }
        const [header = '', body = ''] = readFileSync(source, 'utf8').split(/\r?\n/)
        let plaintext: Buffer
        try {
          if (header !== HEADER || !BASE64.test(body.trim())) throw new DecryptError()
          plaintext = openSealed(key, unpackSealed(Buffer.from(body.trim(), 'base64')), AAD)
        } catch {
          throw commandError(
            'decrypt_failed',
            `${target.label}.encrypted could not be decrypted, so nothing was written.`,
            `Check the key (${KEY_VARIABLE} or --key) and that the file was not changed.`,
            EXIT.VALIDATION,
          )
        }
        writeFileAtomic(target.path, plaintext, { mode: 0o600 })
        ctx.out.success(`Decrypted ${target.label}.encrypted into ${target.label}.`)
        return { data: { file: target.label } }
      },
    }),
  ]
}
