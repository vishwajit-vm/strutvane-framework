/**
 * `GET /docs`: served with the OpenAPI document's visibility rule (public in local development or
 * when chosen, authenticated elsewhere, absent when the document is off), as script-free HTML
 * whose every document value is escaped.
 */
import type { Actor } from '@strutvane/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { DOCS_PAGE_CSP, escapeHtml, renderDocsPage } from '../../src/http/docs-page.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { Customer, Invoice } from '../helpers/models.ts'

const person = (id: string): Actor => ({ id, type: 'user', roles: [], attrs: {} })

let t: TestApp | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

describe('GET /docs', () => {
  it('is public in local development: HTML listing the API, no scripts, same CSP rules', async () => {
    t = await createTestApp({
      resources: [Customer, Invoice],
      http: { env: 'local', info: { title: 'Acme <b>CRM</b>', version: '2.0.0' } },
    })
    const r = await t.http.request('/docs')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('content-security-policy')).toBe(DOCS_PAGE_CSP)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    const html = await r.text()
    expect(html).toContain('/api/v1/invoices')
    expect(html).toContain('/api/v1/customers/{id}')
    expect(html).toContain('href="/openapi.json"')
    expect(html).toContain('Acme &lt;b&gt;CRM&lt;/b&gt;')
    expect(html).not.toContain('<b>CRM')
    expect(html).not.toMatch(/<script/i)
  })

  it('needs an identified caller outside local, like /openapi.json', async () => {
    t = await createTestApp({ resources: [Customer, Invoice], http: { env: 'production' } })
    const anon = await t.request('GET', '/docs')
    expect(anon.status).toBe(401)
    expect(anon.headers.get('content-type')).toContain('problem+json')
    expect((await t.actingAs(person('u')).request('GET', '/docs')).status).toBe(200)
  })

  it('follows an explicit choice: public, or off (404)', async () => {
    t = await createTestApp({
      resources: [Customer, Invoice],
      http: { env: 'production', openapi: 'public' },
    })
    expect((await t.request('GET', '/docs')).status).toBe(200)
    await t.close()
    t = await createTestApp({ resources: [Customer, Invoice], http: { openapi: false } })
    expect((await t.actingAs(person('u')).request('GET', '/docs')).status).toBe(404)
  })
})

describe('renderDocsPage', () => {
  it('escapes every document value and groups operations by tag', () => {
    const html = renderDocsPage({
      info: { title: '"><img src=x onerror=alert(1)>', version: '<1>' },
      paths: {
        '/a/{id}': {
          get: {
            tags: ['Alpha'],
            summary: '<script>x</script>',
            description: "it's & more",
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'q<', in: 'query', schema: { type: 'array', items: { $ref: '#/c/s/Q' } } },
              'junk',
            ],
            requestBody: { content: { 'application/json': { schema: { $ref: '#/x/Body' } } } },
            responses: { '200': {}, '404': {} },
          },
          trace: { summary: 'ignored method' },
        },
        '/b': { post: { operationId: 'makeB' }, parameters: [] },
        '/c': 'junk',
      },
    })
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('it&#39;s &amp; more')
    expect(html).toContain('<h2>Alpha</h2>')
    expect(html).toContain('<h2>Other</h2>')
    expect(html).toContain('makeB')
    expect(html).toContain('Q[]')
    expect(html).toContain('Body')
    expect(html).toContain('<code>404</code>')
    expect(html).not.toContain('ignored method')
  })

  it('never throws on a missing or odd document', () => {
    for (const doc of [undefined, null, 'x', [], { paths: [] }, { info: 'x', paths: { '/a': {} } }])
      expect(renderDocsPage(doc)).toContain('No operations.')
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    )
  })
})
