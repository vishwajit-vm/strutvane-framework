/**
 * CSRF on the keyring (spike 12 open question 2): the token key is `keyring.derive('csrf')`, and
 * tokens made with a key in `APP_PREVIOUS_KEYS` still pass after `key:rotate`, so open forms keep
 * working; the `XSRF-TOKEN` cookie is then reissued with the current key. A token from a key that
 * was dropped, or from another purpose's subkey, is refused (419).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { StrutvaneError } from '../../src/core/errors/errors.ts'
import { CSRF_ERROR_CODE, csrfProtection, csrfToken, resolveCsrf } from '../../src/http/csrf.ts'
import { sessionCookieName } from '../../src/http/session-cookie.ts'
import { Keyring } from '../../src/security/keyring.ts'

const OLD = randomBytes(32).toString('base64url')
const NEW = randomBytes(32).toString('base64url')
const SESSION = 'session-value-1'
const cookie = sessionCookieName({ secure: false })

function app(keyring: Keyring): Hono {
  const settings = resolveCsrf(
    {},
    { appKey: undefined, keyring, publicUrl: new URL('http://app.test'), cookie },
  )
  const http = new Hono()
  http.onError((error) =>
    error instanceof StrutvaneError && error.code === CSRF_ERROR_CODE
      ? new Response(null, { status: 419 })
      : new Response(null, { status: 500 }),
  )
  http.use('*', csrfProtection(settings, { isHttps: () => false, ownOrigin: () => undefined }))
  http.post('/save', (c) => c.text('saved'))
  return http
}

const post = (http: Hono, token: string): Promise<Response> =>
  Promise.resolve(
    http.request('http://app.test/save', {
      method: 'POST',
      headers: { cookie: `${cookie.name}=${SESSION}; XSRF-TOKEN=${token}`, 'x-xsrf-token': token },
    }),
  )

describe('CSRF tokens on the keyring', () => {
  it('derives the token key from keyring.derive("csrf"), current key first', () => {
    const keyring = Keyring.from(NEW, OLD)
    const settings = resolveCsrf({}, { appKey: undefined, keyring, publicUrl: undefined, cookie })
    expect(settings.key.equals(keyring.derive('csrf'))).toBe(true)
    expect(settings.keys.map((key) => key.toString('hex'))).toEqual(
      keyring.deriveAll('csrf').map((key) => key.toString('hex')),
    )
    // appKey + previousKeys build the same keyring.
    const fromEnv = resolveCsrf(
      {},
      { appKey: NEW, previousKeys: OLD, publicUrl: undefined, cookie },
    )
    expect(fromEnv.keys).toHaveLength(2)
    expect(fromEnv.key.equals(settings.key)).toBe(true)
  })

  it('accepts a token made before key:rotate and reissues the cookie with the current key', async () => {
    const before = Keyring.from(OLD)
    const oldToken = csrfToken(before.derive('csrf'), SESSION)
    const rotated = app(Keyring.from(NEW, OLD))
    const response = await post(rotated, oldToken)
    expect(response.status).toBe(200)
    const reissued = response.headers.getSetCookie().find((c) => c.startsWith('XSRF-TOKEN='))
    expect(reissued).toBe(
      `XSRF-TOKEN=${csrfToken(Keyring.from(NEW).derive('csrf'), SESSION)}; Path=/; SameSite=Lax`,
    )
  })

  it('refuses tokens from a dropped key, another purpose, or the raw APP_KEY', async () => {
    const before = Keyring.from(OLD)
    const current = app(Keyring.from(NEW))
    expect((await post(current, csrfToken(before.derive('csrf'), SESSION))).status).toBe(419)
    const wrongPurpose = csrfToken(Keyring.from(NEW).derive('signer'), SESSION)
    expect((await post(current, wrongPurpose)).status).toBe(419)
    const raw = createHmac('sha256', NEW).update(SESSION).digest('base64url')
    expect((await post(current, raw)).status).toBe(419)
    expect((await post(current, csrfToken(Keyring.from(NEW).derive('csrf'), SESSION))).status).toBe(
      200,
    )
  })

  it('refuses a weak APP_KEY instead of signing tokens with it', () => {
    expect(() => resolveCsrf({}, { appKey: 'short', publicUrl: undefined, cookie })).toThrow(
      'APP_KEY is too short',
    )
  })
})
