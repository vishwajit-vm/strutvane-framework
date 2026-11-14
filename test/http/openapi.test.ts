import { compileErrors, validate } from '@readme/openapi-parser'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineResource } from '../../src/http/resource.ts'
import { route } from '../../src/http/route.ts'
import { createTestApp, type TestApp } from '../../src/testing/index.ts'
import { Customer, Invoice } from '../helpers/models.ts'

// biome-ignore lint/suspicious/noExplicitAny: walking an untyped JSON document in assertions.
type Json = any

describe('OpenAPI document', () => {
  let t: TestApp
  let doc: Json
  beforeAll(async () => {
    t = await createTestApp({
      resources: [
        defineResource({ model: Customer, includes: ['invoices'] }),
        defineResource({ model: Invoice, routes: { restore: false } }),
      ],
      http: {
        routes: [
          route.post('/invoices/:id/mark-paid', {
            name: 'invoices.markPaid',
            permission: 'invoice.markPaid',
            handler: () => ({}),
          }),
          route.get('/hello', { public: true, handler: () => ({ hi: true }) }),
          route.get('/me/summary', { handler: () => ({}) }),
        ],
      },
    })
    // Outside APP_ENV=local the document is served to identified callers only.
    expect((await t.request<Json>('GET', '/openapi.json')).status).toBe(401)
    const res = await t
      .actingAs({ id: 'u', type: 'user', roles: [], attrs: {} })
      .request<Json>('GET', '/openapi.json')
    expect(res.status).toBe(200)
    doc = res.body
  })
  afterAll(async () => {
    await t.close()
  })

  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await validate(structuredClone(doc) as never)
    if (!result.valid) throw new Error(compileErrors(result))
    expect(result.valid).toBe(true)
    expect(doc.openapi).toBe('3.1.0')
  })

  it('documents every enabled route with Strutvane extensions', () => {
    expect(
      Object.keys(doc.paths)
        .filter(
          (p) =>
            !Object.values(doc.paths[p] as Record<string, Json>).some((op: Json) =>
              op.tags?.includes('Custom routes'),
            ),
        )
        .sort(),
    ).toEqual(
      [
        '/api/v1/customers',
        '/api/v1/customers/query',
        '/api/v1/customers/{id}',
        '/api/v1/invoices',
        '/api/v1/invoices/query',
        '/api/v1/invoices/{id}',
      ].sort(),
    )
    expect(doc['x-strutvane']).toEqual({
      manifest: '/.well-known/strutvane.json',
      listProtocol: 'strutvane-list-query',
    })
    const list = doc.paths['/api/v1/invoices'].get
    expect(list['x-strutvane-permission']).toBe('invoice.viewAny')
    expect(list['x-strutvane-action']).toBe('list')
    expect(doc.paths['/api/v1/invoices'].post['x-strutvane-permission']).toBe('invoice.create')
    // restore exists only for soft-delete models, and can be turned off per resource
    expect(doc.paths['/api/v1/invoices/{id}/restore']).toBeUndefined()
    expect(doc.paths['/api/v1/customers/{id}'].delete['x-strutvane-permission']).toBe(
      'customer.delete',
    )
  })

  it('documents custom routes: path params, access and problems', () => {
    const paid = doc.paths['/api/v1/invoices/{id}/mark-paid']?.post
    expect(paid?.operationId).toBe('invoicesMarkPaid')
    expect(paid?.['x-strutvane-permission']).toBe('invoice.markPaid')
    expect(paid?.parameters?.map((p: Json) => p.name)).toEqual(['id'])
    expect(Object.keys(paid?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401', '403', '422']),
    )
    const hello = doc.paths['/api/v1/hello']?.get
    expect(hello?.description).toContain('Public')
    expect(hello?.responses?.['401']).toBeUndefined()
    expect(doc.paths['/api/v1/me/summary']?.get?.description).toContain('signed-in')
  })

  it('documents the list protocol and problem+json errors', () => {
    const list = doc.paths['/api/v1/invoices'].get
    const filter = list.parameters.find((p: Json) => p.name === 'filter')
    expect(filter['x-strutvane-serialization']).toBe('strutvane-list-query')
    expect(Object.keys(filter.schema.properties).sort()).toEqual(
      [
        'amount',
        'createdAt',
        'customer',
        'deletedAt',
        'id',
        'issuedOn',
        'number',
        'status',
        'updatedAt',
      ].sort(),
    )
    expect(filter.schema.properties.status.properties.in.items.enum).toEqual([
      'draft',
      'sent',
      'paid',
    ])
    const sort = list.parameters.find((p: Json) => p.name === 'sort')
    expect(sort.schema.items.enum).toContain('-amount')
    expect(list.responses['422'].content['application/problem+json']).toBeDefined()
    const custList = doc.paths['/api/v1/customers'].get
    expect(custList.parameters.find((p: Json) => p.name === 'include').schema.items.enum).toEqual([
      'invoices',
    ])
  })

  it('carries field metadata on component schemas', () => {
    const invoice = doc.components.schemas.Invoice
    expect(invoice.properties.amount['x-strutvane-field']).toMatchObject({
      type: 'decimal',
      sortable: true,
    })
    expect(invoice.properties.customer['x-strutvane-field']).toMatchObject({
      type: 'belongsTo',
      relation: 'Customer',
    })
    expect(doc.components.schemas.InvoiceCreate.additionalProperties).toBe(false)
  })

  it('is deterministic', async () => {
    const again = await t
      .actingAs({ id: 'u2', type: 'user', roles: [], attrs: {} })
      .request<Json>('GET', '/openapi.json')
    expect(JSON.stringify(again.body)).toBe(JSON.stringify(doc))
  })
})
