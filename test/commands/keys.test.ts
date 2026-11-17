/**
 * Keys and secrets through their commands: `key:rotate` (old ciphertexts and signed links keep
 * working, the new key is never printed, the config cache is dropped) and `env:encrypt` /
 * `env:decrypt` (round trip, wrong key, tampering, truncated tags, nothing written on failure).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseEnvKey } from '../../src/console/commands/app/env-crypt.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import { url } from '../../src/routing/url.ts'
import { EncrypterToken } from '../../src/security/encrypter.ts'
import { formatEnvValue, readEnvValue, setEnvValues } from '../../src/support/env-file.ts'
import { testClient } from '../../src/testing/app-client.ts'
import { APP_KEY, appFolder, buildApp, cleanupFolders, newKey, strut } from './helpers.ts'

afterEach(cleanupFolders)

const envOf = (base: string, name = '.env'): string => readFileSync(join(base, name), 'utf8')
const valueOf = (text: string, key: string): string | undefined =>
  new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]

const signedRoutes = defineRoutes([
  Route.get('/unsubscribe/{user}', (ctx) => ctx.json({ user: ctx.param('user') }))
    .name('unsubscribe')
    .middleware('signed'),
])

describe('key:rotate', () => {
  it('sets a new key, keeps the old one first, and old ciphertexts and signed links keep working', async () => {
    const base = appFolder({
      '.env': `# keep me\nAPP_NAME="Blog"\nAPP_KEY=${APP_KEY}\nAPP_PREVIOUS_KEYS=\n`,
    })
    const before = buildApp(base, { web: signedRoutes })
    await before.app.boot()
    const secret = before.app.make(EncrypterToken).encryptString('card-ending-4242')
    const link = before.app.run(() => url.signedRoute('unsubscribe', { user: 7 }))
    // A config cache holds the old key: rotation must remove it.
    await strut(['config:cache'], { cwd: base })
    expect(existsSync(join(base, 'bootstrap', 'cache', 'config.json'))).toBe(true)

    const rotated = await strut(['key:rotate', '--json'], { cwd: base })
    expect(rotated.code).toBe(0)
    expect(rotated.json().data).toEqual({
      rotated: true,
      previousKeys: 1,
      configCacheRemoved: true,
    })
    const text = envOf(base)
    const current = valueOf(text, 'APP_KEY') ?? ''
    expect(current).not.toBe(APP_KEY)
    expect(valueOf(text, 'APP_PREVIOUS_KEYS')).toBe(APP_KEY)
    expect(text).toContain('# keep me\nAPP_NAME="Blog"\n')
    expect(rotated.stdout).not.toContain(current)
    expect(existsSync(join(base, 'bootstrap', 'cache', 'config.json'))).toBe(false)

    const after = buildApp(base, {
      web: signedRoutes,
      env: { APP_KEY: current, APP_PREVIOUS_KEYS: APP_KEY },
    })
    await after.app.boot()
    expect(after.app.make(EncrypterToken).decryptString(secret)).toBe('card-ending-4242')
    ;(await testClient(after.app).getJson(link)).assertStatus(200).assertJsonPath('user', '7')
    // New values use the new key: an app that only knows the old key can't read them.
    const fresh = after.app.make(EncrypterToken).encryptString('new')
    const oldOnly = buildApp(base, { env: { APP_KEY } })
    await oldOnly.app.boot()
    expect(() => oldOnly.app.make(EncrypterToken).decryptString(fresh)).toThrow()
    // Once the old key is dropped, its links stop working.
    const dropped = buildApp(base, {
      web: signedRoutes,
      env: { APP_KEY: current, APP_PREVIOUS_KEYS: '' },
    })
    ;(await testClient(dropped.app).getJson(link)).assertProblem(403, 'invalid_signature')

    // A second rotation keeps both earlier keys, newest first, without duplicates.
    await strut(['key:rotate'], { cwd: base })
    expect(valueOf(envOf(base), 'APP_PREVIOUS_KEYS')).toBe(`${current},${APP_KEY}`)
  })

  it('refuses without a .env or without a valid key, and needs confirmation in production', async () => {
    const base = appFolder()
    const missing = await strut(['key:rotate', '--json'], { cwd: base })
    expect(missing.code).toBe(3)
    expect(missing.json().error?.code).toBe('no_env_file')
    writeFileSync(join(base, '.env'), 'APP_KEY=too-short\n')
    const weak = await strut(['key:rotate', '--json'], { cwd: base })
    expect(weak.json().error?.code).toBe('no_key_to_rotate')
    expect(envOf(base)).toBe('APP_KEY=too-short\n')
    writeFileSync(join(base, '.env'), `APP_ENV=production\nAPP_KEY=${APP_KEY}\n`)
    const guarded = await strut(['key:rotate', '--json'], {
      cwd: base,
      env: { APP_ENV: undefined },
    })
    expect(guarded.json().error?.code).toBe('production_guard')
    expect(valueOf(envOf(base), 'APP_KEY')).toBe(APP_KEY)
    const forced = await strut(['key:rotate', '--force', '--i-understand'], {
      cwd: base,
      env: { APP_ENV: undefined },
    })
    expect(forced.code).toBe(0)
  })
})

describe('env:encrypt and env:decrypt', () => {
  const ENV = 'APP_KEY=base64:live\nDB_PASSWORD="p@ss word"\n'

  it('round-trips .env.<name> with a generated key printed once and never stored', async () => {
    const base = appFolder({ '.env.production': ENV })
    const encrypted = await strut(['env:encrypt', '--env', 'production', '--json'], { cwd: base })
    expect(encrypted.code).toBe(0)
    const data = encrypted.json().data as { file: string; generatedKey: string }
    expect(data.file).toBe('.env.production.encrypted')
    const file = envOf(base, '.env.production.encrypted')
    expect(file.startsWith('STRUTVANE-ENV-1\n')).toBe(true)
    expect(file).not.toContain('p@ss word')
    expect(file).not.toContain(data.generatedKey.slice(7))
    writeFileSync(join(base, '.env.production'), 'stale')
    // An existing file is never replaced without --force.
    const blocked = await strut(['env:decrypt', '--env', 'production', '--json'], {
      cwd: base,
      env: { STRUT_ENV_KEY: data.generatedKey },
    })
    expect(blocked.json().error?.code).toBe('file_exists')
    const decrypted = await strut(['env:decrypt', '--env', 'production', '--force'], {
      cwd: base,
      env: { STRUT_ENV_KEY: data.generatedKey },
    })
    expect(decrypted.code).toBe(0)
    expect(envOf(base, '.env.production')).toBe(ENV)
  })

  it('a wrong key, a changed file or a truncated tag writes nothing', async () => {
    const base = appFolder({ '.env': ENV })
    const key = newKey()
    await strut(['env:encrypt', `--key=${key}`], { cwd: base })
    writeFileSync(join(base, '.env'), 'untouched')
    const decrypt = (env: Record<string, string>) =>
      strut(['env:decrypt', '--force', '--json'], { cwd: base, env })
    const wrong = await decrypt({ STRUT_ENV_KEY: newKey() })
    expect(wrong.code).toBe(3)
    expect(wrong.json().error?.code).toBe('decrypt_failed')
    const original = envOf(base, '.env.encrypted')
    const [header, body = ''] = original.split('\n')
    const bytes = Buffer.from(body, 'base64')
    for (const cut of [4, 8, 12]) {
      // Shorter tags (4, 8 or 12 bytes) are refused: only full 16-byte GCM tags are accepted.
      writeFileSync(
        join(base, '.env.encrypted'),
        `${header}\n${bytes.subarray(0, bytes.length - cut).toString('base64')}\n`,
      )
      expect((await decrypt({ STRUT_ENV_KEY: key })).json().error?.code).toBe('decrypt_failed')
    }
    const flipped = Buffer.from(bytes)
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 1
    writeFileSync(join(base, '.env.encrypted'), `${header}\n${flipped.toString('base64')}\n`)
    expect((await decrypt({ STRUT_ENV_KEY: key })).json().error?.code).toBe('decrypt_failed')
    writeFileSync(join(base, '.env.encrypted'), `OTHER-FORMAT\n${body}\n`)
    expect((await decrypt({ STRUT_ENV_KEY: key })).json().error?.code).toBe('decrypt_failed')
    writeFileSync(join(base, '.env.encrypted'), `${header}\nnot base64!!\n`)
    expect((await decrypt({ STRUT_ENV_KEY: key })).json().error?.code).toBe('decrypt_failed')
    expect(envOf(base)).toBe('untouched')
    // The flag works too (the variable is preferred).
    writeFileSync(join(base, '.env.encrypted'), original)
    const viaFlag = await strut(['env:decrypt', '--force', `--key=${key}`], { cwd: base })
    expect(viaFlag.code).toBe(0)
    expect(envOf(base)).toBe(ENV)
  })

  it('explains missing files, missing or malformed keys, and existing outputs', async () => {
    const base = appFolder()
    expect((await strut(['env:encrypt', '--json'], { cwd: base })).json().error?.code).toBe(
      'no_env_file',
    )
    expect((await strut(['env:decrypt', '--json'], { cwd: base })).json().error?.code).toBe(
      'no_encrypted_file',
    )
    writeFileSync(join(base, '.env'), ENV)
    for (const bad of ['plain', 'base64:', `base64:${randomBytes(16).toString('base64')}`]) {
      const result = await strut(['env:encrypt', `--key=${bad}`, '--json'], { cwd: base })
      expect(result.code, bad).toBe(2)
      expect(result.json().error?.code).toBe('invalid_env_key')
      expect(JSON.stringify(result.json())).not.toContain(bad.slice(7) || 'plain-never')
    }
    expect(() => parseEnvKey(`base64:${randomBytes(32).toString('base64')}=`)).toThrow()
    await strut(['env:encrypt'], { cwd: base })
    const again = await strut(['env:encrypt', '--json'], { cwd: base })
    expect(again.json().error?.code).toBe('file_exists')
    expect((await strut(['env:encrypt', '--force'], { cwd: base })).code).toBe(0)
    const noKey = await strut(['env:decrypt', '--json'], { cwd: base, env: { STRUT_ENV_KEY: '' } })
    expect(noKey.json().error?.code).toBe('no_env_key')
  })

  it('replacing a decrypted file outside local and testing needs --i-understand', async () => {
    const base = appFolder({ '.env': ENV })
    const key = newKey()
    await strut(['env:encrypt', `--key=${key}`], { cwd: base })
    const guarded = await strut(['env:decrypt', '--force', '--json'], {
      cwd: base,
      env: { APP_ENV: 'production', STRUT_ENV_KEY: key },
    })
    expect(guarded.json().error?.code).toBe('production_guard')
    const confirmed = await strut(['env:decrypt', '--force', '--i-understand'], {
      cwd: base,
      env: { APP_ENV: 'production', STRUT_ENV_KEY: key },
    })
    expect(confirmed.code).toBe(0)
  })
})

describe('.env editing (support/env-file.ts)', () => {
  it('quotes when needed, keeps CRLF, export prefixes and the BOM, and never injects a line', () => {
    expect(formatEnvValue('base64:abc=')).toBe('base64:abc=')
    expect(formatEnvValue('two words')).toBe("'two words'")
    expect(formatEnvValue("it's")).toBe('"it\'s"')
    for (const unsafe of [
      'a\nB=1',
      'a\rb',
      'a\0b',
      `it's "both"`,
      `back${String.fromCharCode(92)}slash'`,
    ])
      expect(() => formatEnvValue(unsafe), unsafe).toThrow(
        expect.objectContaining({ code: 'unsafe_env_value' }),
      )
    expect(
      setEnvValues('\uFEFFexport APP_KEY=old\r\nAPP_KEY=dup\r\n', {
        APP_KEY: 'new',
        NEW_ONE: 'x y',
      }),
    ).toBe("\uFEFFexport APP_KEY=new\r\nAPP_KEY=new\r\nNEW_ONE='x y'\r\n")
    expect(() => setEnvValues('', { 'bad-key': 'x' })).toThrow(
      expect.objectContaining({ code: 'unsafe_env_key' }),
    )
    expect(readEnvValue('\uFEFFAPP_KEY="quoted"\n', 'APP_KEY')).toBe('quoted')
    expect(readEnvValue('APP_KEY=\n', 'APP_KEY')).toBeUndefined()
  })
})
