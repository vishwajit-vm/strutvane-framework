/**
 * Maintenance mode through its commands, `node strut down` and `up`, and the per-request check:
 * 503 with Retry-After/Refresh, `/up` stays healthy, bypass secrets (never stored), the bypass
 * cookie, same-origin redirects only, the pre-rendered page, a corrupt state file failing closed,
 * key rotation during maintenance and a state shared with another process.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS } from '../../src/console/commands/builtins.ts'
import {
  BYPASS_COOKIE,
  bypassCookieValue,
  checkMaintenance,
  maintenanceRedirect,
} from '../../src/maintenance/maintenance.ts'
import { readMaintenancePage } from '../../src/maintenance/page.ts'
import { DOWN_FILE, MAX_PAGE_BYTES, readMaintenance } from '../../src/maintenance/state.ts'
import { Keyring } from '../../src/security/keyring.ts'
import { testClient } from '../../src/testing/app-client.ts'
import {
  APP_KEY,
  appFolder,
  buildApp,
  cleanupFolders,
  NOW,
  newKey,
  ROOT,
  strut,
  writeFiles,
  writeRealApp,
} from './helpers.ts'

afterEach(cleanupFolders)

const downFile = (base: string): string => join(base, DOWN_FILE)

/** A fresh app on `base` (as the next process would load it) and its test client. */
function client(base: string, env: Readonly<Record<string, string>> = {}) {
  const { app } = buildApp(base, { env })
  return { app, http: testClient(app) }
}

describe('down and up', () => {
  it('answers 503 with Retry-After and Refresh, keeps /up healthy, and up brings it back', async () => {
    const base = appFolder()
    const down = await strut(['down', '--retry=60', '--refresh=15', '--json'], { cwd: base })
    expect(down.code).toBe(0)
    expect(down.json().data).toEqual({ down: true, retry: 60, refresh: 15, rendered: false })
    const state = JSON.parse(readFileSync(downFile(base), 'utf8')) as { since: number }
    expect(state.since).toBe(Math.floor(NOW / 1000))
    const { http } = client(base)
    const blocked = await http.getJson('/posts')
    blocked.assertProblem(503, 'maintenance_mode')
    expect(blocked.headers.get('retry-after')).toBe('60')
    expect(blocked.headers.get('refresh')).toBe('15')
    expect(blocked.json).toMatchObject({ title: 'Down for maintenance' })
    ;(await http.getJson('/up')).assertStatus(200).assertJsonPath('status', 'ok')
    const up = await strut(['up', '--json'], { cwd: base })
    expect(up.json().data).toEqual({ up: true, wasDown: true })
    expect(existsSync(downFile(base))).toBe(false)
    ;(await client(base).http.getJson('/posts')).assertStatus(200)
    const again = await strut(['up'], { cwd: base })
    expect(again.stdout).toContain('was not in maintenance mode')
  })

  it('up works even when the app cannot boot', async () => {
    const base = appFolder()
    await strut(['down'], { cwd: base })
    const up = await strut(['up'], {
      cwd: base,
      app: () => buildApp(base, { env: { APP_KEY: 'too-short' } }).app,
    })
    expect(up.code).toBe(0)
    expect(existsSync(downFile(base))).toBe(false)
  })

  it('refuses bad options before writing anything', async () => {
    const base = appFolder()
    const cases: [string[], string][] = [
      [['--retry=soon'], 'invalid_option'],
      [['--retry=999999999'], 'invalid_option'],
      [['--refresh=-1'], 'invalid_option'],
      [['--secret=short'], 'invalid_option'],
      [['--secret=has/slash!'], 'invalid_option'],
      [['--secret=valid-secret-1', '--with-secret'], 'invalid_option'],
    ]
    for (const [flags, code] of cases) {
      const result = await strut(['down', ...flags, '--json'], { cwd: base })
      expect(result.code, flags.join(' ')).toBe(2)
      expect(result.json().error?.code).toBe(code)
    }
    expect(existsSync(downFile(base))).toBe(false)
  })

  it('refuses a boot failure without going down', async () => {
    const base = appFolder()
    const result = await strut(['down', '--json'], {
      cwd: base,
      app: () => buildApp(base, { env: { APP_KEY: 'too-short' } }).app,
    })
    expect(result.code).toBe(3)
    expect(existsSync(downFile(base))).toBe(false)
  })
})

describe('bypass secrets', () => {
  it('--with-secret prints the bypass URL once, stores only an HMAC, and sets a bypass cookie', async () => {
    const base = appFolder()
    const down = await strut(['down', '--with-secret', '--json'], { cwd: base })
    const bypassUrl = String(
      down.json().data && (down.json().data as { bypassUrl: string }).bypassUrl,
    )
    const secret = bypassUrl.slice('http://localhost/'.length)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const stored = readFileSync(downFile(base), 'utf8')
    expect(stored).not.toContain(secret)
    expect(stored).toMatch(/"secretHash": "[a-f0-9]{64}"/)
    const { http } = client(base)
    const enter = await http.get(`/${secret}`)
    enter.assertStatus(302)
    expect(enter.headers.get('location')).toBe('/')
    const cookie = enter.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${BYPASS_COOKIE}=`)
    expect(cookie).toContain('HttpOnly; SameSite=Lax')
    const value = /strutvane_maintenance=([^;]+)/.exec(cookie)?.[1] ?? ''
    ;(await http.withCookie(BYPASS_COOKIE, value).getJson('/posts')).assertStatus(200)
    // A wrong secret is just another path: 503.
    ;(await http.get('/not-the-secret-at-all')).assertStatus(503)
    // A new `down` (new secret) invalidates every earlier cookie.
    await strut(['down', '--secret=team-preview-2026'], { cwd: base })
    const fresh = client(base).http
    ;(await fresh.withCookie(BYPASS_COOKIE, value).getJson('/posts')).assertStatus(503)
    ;(await fresh.get('/team-preview-2026')).assertStatus(302)
  })

  it('refuses forged, expired and secret-less cookies', async () => {
    const base = appFolder()
    await strut(['down', '--secret=team-preview-2026'], { cwd: base })
    const keyring = Keyring.from(APP_KEY)
    const state = readMaintenance(base)
    if (state === undefined) throw new Error('expected the app to be down')
    const now = Math.floor(NOW / 1000)
    const { http } = client(base)
    const expired = bypassCookieValue(keyring, state, now - 1)
    ;(await http.withCookie(BYPASS_COOKIE, expired).getJson('/posts')).assertStatus(503)
    const otherKey = bypassCookieValue(Keyring.from(newKey()), state, now + 60)
    ;(await http.withCookie(BYPASS_COOKIE, otherKey).getJson('/posts')).assertStatus(503)
    for (const junk of ['', 'abc', `${now + 60}.short`, `${now + 60}.${'A'.repeat(43)}x`]) {
      const response = await http.withCookie(BYPASS_COOKIE, junk).getJson('/posts')
      response.assertStatus(503)
    }
    const valid = bypassCookieValue(keyring, state, now + 60)
    ;(await http.withCookie(BYPASS_COOKIE, valid).getJson('/posts')).assertStatus(200)
    // Without a secret, no cookie opens the app.
    await strut(['down'], { cwd: base })
    const noSecret = readMaintenance(base)
    if (noSecret === undefined) throw new Error('expected the app to be down')
    const cookie = bypassCookieValue(keyring, noSecret, now + 60)
    ;(await client(base).http.withCookie(BYPASS_COOKIE, cookie).getJson('/posts')).assertStatus(503)
  })

  it('key:rotate during maintenance keeps the secret and the cookies working', async () => {
    const base = appFolder({ '.env': `APP_KEY=${APP_KEY}\n` })
    await strut(['down', '--secret=team-preview-2026'], { cwd: base })
    const enter = await client(base).http.get('/team-preview-2026')
    const value = /strutvane_maintenance=([^;]+)/.exec(enter.headers.get('set-cookie') ?? '')?.[1]
    const rotated = await strut(['key:rotate'], { cwd: base })
    expect(rotated.code).toBe(0)
    const env = readFileSync(join(base, '.env'), 'utf8')
    const current = /^APP_KEY=(.+)$/m.exec(env)?.[1] ?? ''
    const after = client(base, { APP_KEY: current, APP_PREVIOUS_KEYS: APP_KEY }).http
    ;(await after.withCookie(BYPASS_COOKIE, value ?? '').getJson('/posts')).assertStatus(200)
    ;(await after.get('/team-preview-2026')).assertStatus(302)
  })
})

describe('--redirect', () => {
  it('sends every request to a same-origin path, which itself answers 503', async () => {
    const base = appFolder()
    const down = await strut(['down', '--redirect=/status', '--json'], { cwd: base })
    expect(down.json().data).toMatchObject({ redirect: '/status' })
    const { http } = client(base)
    const sent = await http.getJson('/posts')
    sent.assertStatus(302)
    expect(sent.headers.get('location')).toBe('/status')
    ;(await http.getJson('/status')).assertStatus(503)
    ;(await http.getJson('/up')).assertStatus(200)
  })

  it('refuses every off-site or ambiguous target, and stays up', async () => {
    const base = appFolder()
    const hostile = [
      '//evil.example',
      'https://evil.example/',
      'http:evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/%2F%2Fevil.example',
      '%2F%2Fevil.example',
      'javascript:alert(1)',
      ' //evil.example',
    ]
    for (const target of hostile) {
      const result = await strut(['down', `--redirect=${target}`, '--json'], { cwd: base })
      expect(result.code, target).toBe(2)
      expect(result.json().error?.code).toBe('unsafe_redirect')
      expect(maintenanceRedirect(target, 'https://blog.example')).toBeUndefined()
    }
    expect(existsSync(downFile(base))).toBe(false)
  })
})

describe('--render', () => {
  const PAGE = '<!doctype html><h1>Back soon</h1>'

  it('shows the pre-rendered page to browsers with a script-free CSP; API clients get JSON', async () => {
    const base = appFolder({ 'resources/views/maintenance.html': PAGE })
    const down = await strut(['down', '--render=maintenance.html', '--retry=30', '--json'], {
      cwd: base,
    })
    expect(down.json().data).toMatchObject({ rendered: true })
    const { http } = client(base)
    const page = await http.get('/posts')
    page.assertStatus(503)
    expect(page.text).toBe(PAGE)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('content-security-policy')).not.toContain('script-src')
    expect(page.headers.get('retry-after')).toBe('30')
    ;(await http.getJson('/posts')).assertProblem(503, 'maintenance_mode')
  })

  it('refuses paths outside resources/views, links out of it, other files and large pages', async () => {
    const base = appFolder({
      'resources/views/notes.txt': 'not html',
      'resources/views/huge.html': 'x'.repeat(MAX_PAGE_BYTES + 1),
      'secrets.html': '<p>outside</p>',
      '.env': 'APP_KEY=secret\n',
    })
    for (const file of [
      '../../.env',
      '../../secrets.html',
      'notes.txt',
      'missing.html',
      'huge.html',
      '',
    ]) {
      const result = await strut(['down', `--render=${file}`, '--json'], { cwd: base })
      expect(result.code, file).toBe(3)
      expect(result.json().error?.code).toBe('invalid_render')
    }
    try {
      symlinkSync(join(base, 'secrets.html'), join(base, 'resources', 'views', 'link.html'))
    } catch {
      return // Windows without the symlink privilege: the lexical checks above still ran.
    }
    expect(() => readMaintenancePage(base, 'link.html')).toThrow(/through a link/)
    expect(existsSync(downFile(base))).toBe(false)
  })
})

describe('the state file', () => {
  it('a corrupt or hand-edited file keeps the app down (fail closed) and drops bad fields', async () => {
    const base = appFolder()
    mkdirSync(join(base, 'storage', 'framework'), { recursive: true })
    writeFileSync(downFile(base), '{ this is not json')
    const { http } = client(base)
    ;(await http.getJson('/posts')).assertProblem(503, 'maintenance_mode')
    writeFileSync(
      downFile(base),
      JSON.stringify({
        since: 'yesterday',
        retry: -5,
        refresh: 10 ** 9,
        secretHash: 'not-hex',
        redirect: '//evil.example',
        html: 7,
      }),
    )
    expect(readMaintenance(base)).toEqual({ since: 0 })
    const response = await http.getJson('/posts')
    response.assertStatus(503)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
    writeFileSync(downFile(base), '[1, 2]')
    expect(readMaintenance(base)).toEqual({ since: 0 })
    // A folder where the file should be: still down.
    const other = appFolder()
    mkdirSync(downFile(other), { recursive: true })
    expect(readMaintenance(other)).toEqual({ since: 0 })
  })

  it('the per-request check re-reads the file only when it changed', async () => {
    const base = appFolder()
    const keyring = Keyring.from(APP_KEY)
    const options = {
      basePath: base,
      keyring,
      healthPath: '/up',
      now: () => NOW,
      secureCookies: true,
    }
    expect(await checkMaintenance(new Request('http://localhost/'), options)).toBeUndefined()
    await strut(['down', '--retry=5'], { cwd: base })
    await expect(checkMaintenance(new Request('http://localhost/'), options)).rejects.toMatchObject(
      {
        code: 'maintenance_mode',
        headers: { 'retry-after': '5' },
      },
    )
    await strut(['down', '--retry=9'], { cwd: base })
    await expect(checkMaintenance(new Request('http://localhost/'), options)).rejects.toMatchObject(
      {
        headers: { 'retry-after': '9' },
      },
    )
    await strut(['down', '--secret=team-preview-2026'], { cwd: base })
    // Secure cookies in production, or whenever the request itself is https.
    const enter = await checkMaintenance(new Request('http://localhost/team-preview-2026'), options)
    expect(enter?.headers.get('set-cookie')).toContain('; Secure')
    const plain = await checkMaintenance(new Request('http://localhost/team-preview-2026'), {
      ...options,
      secureCookies: false,
    })
    expect(plain?.headers.get('set-cookie')).not.toContain('Secure')
    const tls = await checkMaintenance(new Request('https://localhost/team-preview-2026'), {
      ...options,
      secureCookies: false,
    })
    expect(tls?.headers.get('set-cookie')).toContain('; Secure')
  })

  it('every process sees the same state: another Node process reads what down wrote', async () => {
    const base = appFolder()
    writeRealApp(base)
    // The real loader, as `node strut down` in another terminal would run it.
    const down = await strut(['down', '--retry=42'], { cwd: base, builtins: BUILTIN_COMMANDS })
    expect(down.code).toBe(0)
    const script = `import { pathToFileURL } from 'node:url'
const { readMaintenance } = await import(pathToFileURL(${JSON.stringify(join(ROOT, 'src', 'maintenance', 'state.ts'))}).href)
process.stdout.write(JSON.stringify(readMaintenance(${JSON.stringify(base)}) ?? null))`
    const read = (): unknown =>
      JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }),
      )
    expect(read()).toMatchObject({ retry: 42 })
    await strut(['up'], { cwd: base, builtins: BUILTIN_COMMANDS })
    expect(read()).toBeNull()
    expect(pathToFileURL(base).href).toContain('file:')
  })
})

describe('writeFiles helper', () => {
  it('keeps nested views', () => {
    const base = appFolder()
    writeFiles(base, { 'resources/views/a/b.html': '<p>x</p>' })
    expect(readMaintenancePage(base, 'a/b.html')).toBe('<p>x</p>')
  })
})
