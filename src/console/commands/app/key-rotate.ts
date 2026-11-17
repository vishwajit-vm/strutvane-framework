/**
 * `node strut key:rotate`: replace `APP_KEY` and keep the old key, first, in `APP_PREVIOUS_KEYS`.
 *
 * The keyring produces new values (encrypted fields, signed links, caches, maintenance cookies)
 * with the current key and still accepts every previous key, so nothing made before the rotation
 * stops working. Drop an old key from `APP_PREVIOUS_KEYS` once the values and links made with it
 * have expired or been re-encrypted.
 *
 * - The new key is never printed (it would land in scrollback and CI logs).
 * - `.env` is rewritten atomically with mode 0600, every other line kept as it was.
 * - The config cache is removed: it holds the old `APP_KEY` value, and since the old key is still
 *   in the keyring the cache would otherwise keep booting the app with the old key as current.
 *
 * Destructive: it needs its exact name, and outside local and testing environments
 * `--force --i-understand`.
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearCache } from '../../../foundation/bootstrap-cache.ts'
import { keyProblem } from '../../../security/keyring.ts'
import { writeFileAtomic } from '../../../support/atomic-write.ts'
import { readEnvValue, setEnvValues } from '../../../support/env-file.ts'
import type { AnyCommand } from '../../framework/command.ts'
import { EXIT } from '../../framework/exit-codes.ts'
import { generateAppKey } from '../env.ts'
import { appRoot, commandError, defineAppCommand, plural } from './support.ts'

/**
 * The `key:rotate` command.
 *
 * @example
 * keyRotateCommand()
 */
export function keyRotateCommand(): AnyCommand {
  return defineAppCommand({
    name: 'key:rotate',
    description: 'Replace APP_KEY and keep the old one first in APP_PREVIOUS_KEYS',
    details: [
      'Encrypted values, signed links and caches made with the old key keep working.',
      'Afterwards deploy the new .env everywhere, and run node strut optimize again if you cache',
      'config. CSRF tokens change too: open forms need one reload.',
    ].join('\n'),
    requiresProject: false,
    destructive: true,
    examples: ['node strut key:rotate', 'node strut key:rotate --force --i-understand'],
    run(ctx) {
      const root = appRoot(ctx)
      const path = join(root, '.env')
      if (!existsSync(path))
        throw commandError(
          'no_env_file',
          'There is no .env file, so there is no key to rotate.',
          'Run node strut key:generate to create a first key.',
          EXIT.VALIDATION,
        )
      const text = readFileSync(path, 'utf8')
      const current = readEnvValue(text, 'APP_KEY')
      const problem = keyProblem(current)
      if (current === undefined || problem !== undefined)
        throw commandError(
          'no_key_to_rotate',
          `APP_KEY in .env ${problem ?? 'is missing'}, so there is nothing to rotate.`,
          'Run node strut key:generate to set a first key.',
          EXIT.VALIDATION,
        )
      const previous = (readEnvValue(text, 'APP_PREVIOUS_KEYS') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '' && value !== current)
      writeFileAtomic(
        path,
        setEnvValues(text, {
          APP_KEY: generateAppKey(),
          APP_PREVIOUS_KEYS: [current, ...previous].join(','),
        }),
        { mode: 0o600 },
      )
      const configCacheRemoved = clearCache(root, 'config')
      ctx.out.success('New APP_KEY set; the old key is first in APP_PREVIOUS_KEYS.')
      ctx.out.line(
        `  ${plural(previous.length + 1, 'previous key')} still accepted for decryption and signed links.`,
      )
      ctx.out.line(
        '  Deploy the new .env everywhere, and run node strut optimize again if you cache config.',
      )
      return { data: { rotated: true, previousKeys: previous.length + 1, configCacheRemoved } }
    },
  })
}
