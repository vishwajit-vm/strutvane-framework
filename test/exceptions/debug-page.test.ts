/**
 * The exception handler end to end: the developer error page (local/testing + APP_DEBUG only),
 * its "Copy as Markdown for AI" twin, the JSON `debug` member, production's plain 500 whose
 * reference matches the log, and the attacks: XSS through the message, path and headers,
 * secrets in headers/query/message, debug in production, nonce reuse, frames outside the app,
 * and huge messages.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { blogApp, testEnv } from '../app/helpers.ts'
import { failWith, misconfigured } from './fixtures/shop/app/services/checkout.ts'
import { copiedMarkdown, cspNonce, shopApp } from './helpers.ts'

const SECRET = `sk_live_${randomBytes(12).toString('hex')}`
const JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3In0.${randomBytes(8).toString('base64url')}`

const hostileHeaders = {
  authorization: `Bearer ${SECRET}`,
  cookie: `strutvane_session=${SECRET}`,
  'x-api-key': SECRET,
  'x-forwarded-token': SECRET,
  'x-custom-auth': `Bearer ${SECRET}`,
  'x-jwt-ish': JWT,
  'x-evil': '"><script>alert("header")</script>',
}

describe('debug mode (APP_DEBUG=true, APP_ENV=testing)', () => {
  it('renders the page with the throwing app line, redacted headers and query, and a copy button', async () => {
    const { client, logger } = await blogApp()
    const page = await client
      .withHeaders({ authorization: 'Bearer super-secret', cookie: 'strutvane_session=abc' })
      .get('/_diagnostics/boom?token=xyz&page=2')
    page.assertStatus(500)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.text).toContain('<h1>TypeError</h1>')
    expect(page.text).toContain('Cannot read properties of undefined (reading &quot;title&quot;)')
    expect(page.text).toContain('app/http/controllers/diagnostics.controller.ts:7')
    expect(page.text).toContain('<span class="hl">   7 |     throw new TypeError(')
    expect(page.text).toContain('Copy as Markdown for AI')
    expect(page.text).not.toContain('super-secret')
    expect(page.text).not.toContain('xyz')
    expect(page.text).toContain('/_diagnostics/boom?token=[REDACTED]&amp;page=2')
    expect(page.text).toContain('diagnostics.boom /_diagnostics/boom')
    const nonce = /'nonce-([^']+)'/.exec(page.headers.get('content-security-policy') ?? '')?.[1]
    expect(nonce).toBeDefined()
    expect(page.text).toContain(`<script nonce="${nonce ?? ''}">`)
    const errors = logger.entries.filter((entry) => entry.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.fields).toMatchObject({
      method: 'GET',
      route: '/_diagnostics/boom',
      traceId: page.headers.get('x-request-id'),
    })
  })

  it('answers JSON clients with problem+json plus a debug member', async () => {
    const { client } = await blogApp()
    const response = await client.getJson('/_diagnostics/boom')
    response.assertStatus(500)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(String(response.path('code'))).toMatch(/^internal_error$/i)
    response
      .assertJsonPath('debug.exception', 'TypeError')
      .assertJsonPath('debug.at', 'app/http/controllers/diagnostics.controller.ts:7')
    expect(response.path('debug.route')).toContain('diagnostics.boom')
    expect(response.path('traceId')).toBe(response.headers.get('x-request-id'))
  })

  it('shows a BootError as a 500 with its message and hint on the page and in JSON', async () => {
    const { send } = await shopApp({ '/pay': () => misconfigured() })
    const page = await send('/pay')
    expect(page.status).toBe(500)
    const html = await page.text()
    expect(html).toContain('No payment gateway is configured.')
    expect(html).toContain('→ Set PAYMENT_GATEWAY in .env.')
    expect(html).toContain('missing_gateway')
    expect(html).toContain('app/services/checkout.ts:14')
    const json = (await (
      await send('/pay', { headers: { accept: 'application/json' } })
    ).json()) as {
      debug: { hint: string; code: string }
    }
    expect(json.debug).toMatchObject({
      hint: 'Set PAYMENT_GATEWAY in .env.',
      code: 'missing_gateway',
    })
  })
})

describe('production (APP_ENV=production): plain errors whatever APP_DEBUG says', () => {
  it('shows only a reference id, logs the details under it, and warns that APP_DEBUG is ignored', async () => {
    const { client, logger } = await blogApp(
      { APP_ENV: 'production', APP_DEBUG: 'true' },
      { forceDebug: true },
    )
    const page = await client.get('/_diagnostics/boom')
    page.assertStatus(500)
    expect(page.headers.get('content-type')).toContain('application/problem+json')
    expect(page.text).not.toContain('TypeError')
    expect(page.text).not.toContain('diagnostics.controller')
    expect(page.text).not.toContain('debug')
    const reference = page.headers.get('x-request-id')
    expect(reference).toBeTruthy()
    expect(page.path('traceId')).toBe(reference)
    const reported = logger.entries.find((entry) => entry.level === 'error')
    expect(reported?.fields?.['traceId']).toBe(reference)
    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && entry.message.includes('APP_DEBUG=true is ignored'),
      ),
    ).toBe(true)
    const json = await client.getJson('/_diagnostics/boom')
    expect(json.status).toBe(500)
    expect(json.path('debug')).toBeUndefined()
  })

  it('never shows the page in staging either, nor with APP_DEBUG=false locally', async () => {
    for (const env of [
      { APP_ENV: 'staging', APP_DEBUG: 'true' },
      { APP_ENV: 'local', APP_DEBUG: 'false' },
    ]) {
      const { send } = await shopApp({ '/boom': () => failWith('internal detail') }, { env })
      const response = await send('/boom')
      const text = await response.text()
      expect(response.status).toBe(500)
      expect(response.headers.get('content-type')).toContain('application/problem+json')
      expect(text).not.toContain('internal detail')
      expect(text).not.toContain('checkout.ts')
    }
  })

  it('does not log expected HTTP errors (404, 422…)', async () => {
    const { client, logger } = await blogApp()
    const missing = await client.getJson('/api/posts/nope')
    missing.assertStatus(404)
    expect(logger.entries.filter((entry) => entry.level === 'error')).toEqual([])
  })
})

describe('attacks on the debug page', () => {
  it('escapes HTML in the message, the path and the headers, so nothing injects markup', async () => {
    const { send } = await shopApp({
      '/x/{anything}': () =>
        failWith('<script>alert("message")</script><img src=x onerror=alert(1)>'),
    })
    const response = await send('/x/%3Cscript%3Ealert(2)%3C%2Fscript%3E?q=<svg/onload=alert(3)>', {
      headers: hostileHeaders,
    })
    const html = await response.text()
    expect(response.status).toBe(500)
    expect(html).not.toMatch(/<script>alert/)
    expect(html).not.toMatch(/<img src=x/)
    expect(html).not.toMatch(/<svg/)
    expect(html).toContain('&lt;script&gt;alert(&quot;message&quot;)&lt;/script&gt;')
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(&quot;header&quot;)')
    // Exactly one script element runs, the nonce'd copy button.
    expect(html.match(/<script\b/g)).toHaveLength(1)
    expect(copiedMarkdown(html)).toContain('<script>alert("message")</script>')
  })

  it('never puts credentials in the page, the Markdown or the JSON debug member', async () => {
    const { send, logger } = await shopApp({
      '/db': () =>
        failWith(`connect postgres://app:${SECRET}@db.internal/shop failed; token ${JWT}`),
    })
    const path = `/db?api_token=${SECRET}&password=${SECRET}&signature=${SECRET}&code=${SECRET}&page=2`
    const page = await send(path, { headers: hostileHeaders })
    const html = await page.text()
    const markdown = copiedMarkdown(html)
    const json = await (
      await send(path, { headers: { ...hostileHeaders, accept: 'application/json' } })
    ).text()
    for (const output of [html, markdown, json]) {
      expect(output).not.toContain(SECRET)
      expect(output).not.toContain(JWT)
    }
    expect(markdown).toContain('- authorization: [REDACTED]')
    expect(markdown).toContain('- cookie: [REDACTED]')
    expect(markdown).toContain('- x-api-key: [REDACTED]')
    expect(markdown).toContain('- x-custom-auth: [REDACTED]')
    expect(markdown).toContain('page=2')
    expect(markdown).toContain('postgres://app:[REDACTED]@db.internal/shop')
    // The log keeps the full message for the developer (logs are not public), with the reference.
    expect(logger.entries.filter((entry) => entry.level === 'error')).toHaveLength(2)
  })

  it('never shows the request body', async () => {
    const { send } = await shopApp({
      'POST /orders': async (ctx) => {
        await ctx.request.clone().text()
        return failWith('order failed')
      },
    })
    const response = await send('/orders', {
      method: 'POST',
      // A bearer request is not CSRF-checked; its body is what must never be echoed.
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ card: `4111-${SECRET}` }),
    })
    const html = await response.text()
    expect(response.status).toBe(500)
    expect(html).toContain('order failed')
    expect(html).not.toContain(SECRET)
    expect(html).not.toContain('4111')
    expect(html).toContain('The request body is never shown.')
  })

  it('uses a fresh nonce per response and its own strict CSP over the app default', async () => {
    const { send } = await shopApp({ '/boom': () => failWith('boom') })
    const first = await send('/boom')
    const second = await send('/boom')
    const one = cspNonce(first)
    const two = cspNonce(second)
    expect(one).toBeDefined()
    expect(two).toBeDefined()
    expect(one).not.toBe(two)
    const csp = first.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(await first.text()).toContain(`<script nonce="${one ?? ''}">`)
    // The other security headers still apply to the page.
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('quotes only app frames: the test file and the framework are hidden', async () => {
    const { send } = await shopApp({ '/boom': () => failWith('boom') })
    const html = await (await send('/boom')).text()
    const markdown = copiedMarkdown(html)
    expect(markdown).toContain('app/services/checkout.ts:9')
    expect(markdown).not.toContain('debug-page.test.ts')
    expect(markdown).not.toContain('src/foundation/application.ts')
    expect(markdown).not.toContain('node_modules')
    expect(markdown).toMatch(/frames in Node, dependencies or the framework hidden/)
  })

  it('cuts huge messages, so the page stays small', async () => {
    const huge = `start ${'A'.repeat(500_000)} end`
    const { send } = await shopApp({ '/huge': () => failWith(huge) })
    const html = await (await send('/huge')).text()
    expect(html.length).toBeLessThan(60_000)
    expect(html).toContain('more characters]')
    expect(html).not.toContain(' end')
    const json = await (await send('/huge', { headers: { accept: 'application/json' } })).text()
    expect(json.length).toBeLessThan(20_000)
  })

  it('cannot plant a frame through the message (no reading .env)', async () => {
    const { send } = await shopApp({
      '/plant': () =>
        failWith('boom\n    at evil (/etc/passwd:1:1)\n    at env (C:\\app\\.env:1:1)'),
    })
    const markdown = copiedMarkdown(await (await send('/plant')).text())
    // The message is shown as text, but nothing in it becomes a frame or a quoted file.
    const stack = markdown.slice(markdown.indexOf('## Stack'))
    expect(stack).not.toContain('passwd')
    expect(stack).not.toContain('.env')
    expect(stack).toContain('app/services/checkout.ts:9')
    expect(markdown.match(/^## `/gm)).toHaveLength(1)
  })

  it('keeps APP_DEBUG out of reach of a forged environment header', async () => {
    const { send } = await shopApp(
      { '/boom': () => failWith('forged-env-detail') },
      { env: { ...testEnv, APP_ENV: 'production', APP_DEBUG: 'false' } },
    )
    const response = await send('/boom', {
      headers: { 'x-app-debug': 'true', 'x-app-env': 'local' },
    })
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.text()).not.toContain('forged-env-detail')
  })
})
