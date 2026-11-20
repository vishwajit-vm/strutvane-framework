/**
 * The resource manifest of an application (`GET /.well-known/strutvane.json`, ADR-0014).
 *
 * Acceptance FW-6: a generated app answered 404 here, so `@strutvane/ui` signed in and then
 * showed "The app could not load its screens". These tests pin what the UI relies on: the URL
 * (the origin's well-known path, whatever the API base path), the shape the UI's parser accepts
 * (field names, a title field that is a field, known filter operators), and that capabilities
 * are the API's own policy decisions per actor, with nothing leaked to an actor who may do
 * nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Policy } from '../../src/auth/gate.ts'
import type { ResourceManifest } from '../../src/contracts/index.ts'
import { MANIFEST_PATH } from '../../src/contracts/index.ts'
import {
  apiVersionOf,
  buildAppManifest,
  type ManifestResource,
  readAppMetadata,
} from '../../src/http/app/manifest.ts'
import type { ResourceMetadata } from '../../src/http/app/resource-model.ts'
import { defineRoutes, Route } from '../../src/routing/route.ts'
import type { AppMetadata } from '../../src/schema/generate/metadata.ts'
import { AuthorController } from './fixtures/blog/app/http/controllers/author.controller.ts'
import { PostController } from './fixtures/blog/app/http/controllers/post.controller.ts'
import { author, blogApp, customApp } from './helpers.ts'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** The rules the UI's `parseManifest` refuses a manifest for (ui `core/manifest-client.ts`). */
function assertUiAccepts(manifest: ResourceManifest): void {
  expect(manifest.manifestVersion).toBe(1)
  expect(typeof manifest.app.name).toBe('string')
  expect(typeof manifest.app.apiVersion).toBe('string')
  expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false)
  const names = new Set<string>()
  for (const resource of manifest.resources) {
    expect(names.has(resource.name)).toBe(false)
    names.add(resource.name)
    const fields = resource.fields.map((field) => field.name)
    for (const field of fields) expect(field).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
    expect(fields).toContain(resource.titleField)
    expect(resource.path).toMatch(/^[a-z0-9_-]+$/)
  }
}

const byName = (manifest: ResourceManifest, name: string) =>
  manifest.resources.find((resource) => resource.name === name)

describe('GET /.well-known/strutvane.json on an application (FW-6)', () => {
  it('is served to a guest, per actor and never cached by a shared cache', async () => {
    const { client } = await blogApp()
    const response = await client.getJson(MANIFEST_PATH)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toMatch(/Cookie/)
    const manifest = response.json as ResourceManifest
    assertUiAccepts(manifest)
    expect(manifest.app).toEqual({ name: 'Blog Test', apiVersion: '' })
    expect(manifest.resources.map((resource) => resource.path).sort()).toEqual(['authors', 'posts'])
    // A guest may read both lists; writes need a signed-in user, and routes that don't exist
    // (authors have no update/destroy) are never offered.
    expect(byName(manifest, 'Post')?.capabilities).toEqual({
      list: true,
      view: true,
      create: false,
      update: false,
      delete: false,
      restore: false,
      export: false,
    })
    expect(byName(manifest, 'Author')?.capabilities).toMatchObject({
      list: true,
      create: false,
      update: false,
      delete: false,
    })
  })

  it("follows each user's policy: a writer, and an admin whose before() allows everything", async () => {
    const prepared = await blogApp()
    const asAlice = (await prepared.client.actingAs(author(prepared, 2)).getJson(MANIFEST_PATH))
      .json as ResourceManifest
    expect(byName(asAlice, 'Post')?.capabilities).toMatchObject({
      create: true,
      update: true, // her own posts: the API decides per row
      delete: false, // PostPolicy defines no delete
    })
    expect(byName(asAlice, 'Author')?.capabilities.create).toBe(false)
    const asAdmin = (await prepared.client.actingAs(author(prepared, 1)).getJson(MANIFEST_PATH))
      .json as ResourceManifest
    expect(byName(asAdmin, 'Post')?.capabilities).toMatchObject({
      create: true,
      update: true,
      delete: true,
    })
    expect(byName(asAdmin, 'Author')?.capabilities).toMatchObject({
      create: true,
      update: false, // no route
    })
  })

  it('describes fields from the controller without leaking hidden ones', async () => {
    const { client } = await blogApp()
    const manifest = (await client.getJson(MANIFEST_PATH)).json as ResourceManifest
    const fields = byName(manifest, 'Author')?.fields.map((field) => field.name) ?? []
    expect(fields).toContain('name')
    expect(fields).not.toContain('api_token')
    const id = byName(manifest, 'Author')?.fields.find((field) => field.name === 'id')
    expect(id?.readOnly).toBe(true)
  })

  it('stays at the origin when the API has a versioned base path, with relative paths', async () => {
    const { client } = await customApp({
      api: defineRoutes([Route.apiResource('posts', PostController, { bindBy: 'slug' })]),
      apiPrefix: '/api/v1',
    })
    const manifest = (await client.getJson(MANIFEST_PATH)).json as ResourceManifest
    expect(manifest.app.apiVersion).toBe('v1')
    expect(manifest.resources.map((resource) => resource.path)).toEqual(['posts'])
    expect((await client.getJson(`/api/v1${MANIFEST_PATH}`)).status).toBe(404)
  })

  it('lists no resource without resource routes, and leaves out nested or non-API ones', async () => {
    const empty = await customApp({
      api: defineRoutes([Route.get('/ping', (ctx) => ctx.json({}))]),
    })
    expect(
      ((await empty.client.getJson(MANIFEST_PATH)).json as ResourceManifest).resources,
    ).toEqual([])
    const odd = await customApp({
      web: defineRoutes([Route.apiResource('authors', AuthorController)]),
      api: defineRoutes([Route.apiResource('authors.posts', PostController)]),
    })
    expect(((await odd.client.getJson(MANIFEST_PATH)).json as ResourceManifest).resources).toEqual(
      [],
    )
  })
})

const CUSTOMERS: ResourceMetadata = {
  table: 'customers',
  model: 'Customer',
  label: { singular: 'Customer', plural: 'Customers' },
  primaryKey: 'id',
  fields: [
    {
      name: 'id',
      label: 'Id',
      kind: 'id',
      cast: 'integer',
      nullable: false,
      required: false,
      fillable: false,
      unique: true,
      hidden: false,
    },
  ],
}

const ORDERS: ResourceMetadata = { ...CUSTOMERS, table: 'orders', model: 'Order' }

/** `.strutvane/resources.json` as `node strut migrate` writes it (trimmed). */
const GENERATED: AppMetadata = {
  version: 1,
  internal: ['users'],
  resources: [
    {
      table: 'orders',
      model: 'Order',
      route: 'orders',
      label: { singular: 'Order', plural: 'Orders' },
      primaryKey: 'id',
      titleField: 'number',
      timestamps: true,
      softDeletes: true,
      defaultSort: '-created_at',
      perPage: 25,
      relations: [],
      sidebar: { order: 2, hidden: false },
      fields: [
        {
          name: 'number',
          label: 'Number',
          kind: 'string',
          cast: 'string',
          nullable: false,
          required: true,
          fillable: true,
          unique: true,
          hidden: false,
          searchable: 'text',
          sortable: true,
          listed: true,
          input: 'text',
          filterOperators: ['eq', 'contains', 'null'],
          maxLength: 20,
        },
        {
          name: 'customer_id',
          label: 'Customer',
          kind: 'foreignId',
          cast: 'integer',
          nullable: false,
          required: true,
          fillable: true,
          unique: false,
          hidden: false,
          searchable: false,
          sortable: true,
          listed: false,
          input: 'relation',
          filterOperators: ['eq', 'in'],
          references: 'customers',
        },
        {
          name: 'status',
          label: 'Status',
          kind: 'enum',
          cast: 'string',
          nullable: false,
          required: false,
          fillable: true,
          unique: false,
          hidden: false,
          searchable: false,
          sortable: true,
          listed: true,
          input: 'select',
          filterOperators: ['eq', 'in'],
          options: ['open', 'shipped'],
        },
        {
          name: 'secret_note',
          label: 'Secret note',
          kind: 'text',
          cast: 'string',
          nullable: true,
          required: false,
          fillable: false,
          unique: false,
          hidden: true,
          searchable: false,
          sortable: false,
          listed: false,
          input: 'none',
          filterOperators: [],
        },
      ],
    },
    {
      table: 'customers',
      model: 'Customer',
      route: 'customers',
      label: { singular: 'Customer', plural: 'Customers' },
      primaryKey: 'id',
      titleField: 'id',
      timestamps: true,
      softDeletes: false,
      defaultSort: '-created_at',
      perPage: 25,
      relations: [],
      sidebar: { order: 1, hidden: false },
      fields: [],
    },
  ],
}

const allowAll: Policy<unknown> = {
  viewAny: () => true,
  view: () => true,
  create: () => true,
  update: () => true,
  delete: () => true,
}

const resource = (
  path: string,
  metadata: ResourceMetadata,
  policy: Policy<unknown> | undefined,
  actions = ['index', 'store', 'show', 'update', 'destroy'],
): ManifestResource => ({ path, actions: new Set(actions), metadata, policy })

const user = { id: '7', type: 'user' as const, roles: [], attrs: {} }
const build = (resources: readonly ManifestResource[], metadata?: AppMetadata) =>
  buildAppManifest({
    app: { name: 'Northwind', apiVersion: '' },
    resources,
    metadata,
    user,
    now: () => new Date(Date.UTC(2026, 10, 20)),
  })

describe('buildAppManifest: fields from resources.json', () => {
  it('maps labels, inputs, filters, relations, list columns and the sidebar order', async () => {
    const manifest = await build(
      [resource('orders', ORDERS, allowAll), resource('customers', CUSTOMERS, allowAll)],
      GENERATED,
    )
    assertUiAccepts(manifest)
    expect(manifest.generatedAt).toBe('2026-11-20T00:00:00.000Z')
    // Sidebar order from resources.json: customers (1) before orders (2).
    expect(manifest.resources.map((r) => r.name)).toEqual(['Customer', 'Order'])
    const orders = byName(manifest, 'Order')
    expect(orders?.titleField).toBe('number')
    expect(orders?.softDeletes).toBe(true)
    expect(orders?.ui?.listColumns).toEqual(['number', 'status'])
    const fields = Object.fromEntries((orders?.fields ?? []).map((field) => [field.name, field]))
    expect(Object.keys(fields)).toEqual(['number', 'customer_id', 'status'])
    expect(fields['number']).toMatchObject({
      type: 'string',
      required: true,
      unique: true,
      readOnly: false,
      searchable: true,
      filterOperators: ['eq', 'contains', 'isNull', 'isNotNull'],
      schema: { type: 'string', maxLength: 20 },
    })
    expect(fields['customer_id']).toMatchObject({
      type: 'belongsTo',
      widget: 'relation-picker',
      relation: { kind: 'belongsTo', target: 'Customer', foreignKey: 'customer_id' },
    })
    expect(fields['status']).toMatchObject({
      type: 'enum',
      widget: 'select',
      enumValues: ['open', 'shipped'],
    })
    // resources.json describes no customer field: the controller's own fields are used.
    expect(byName(manifest, 'Customer')?.fields.map((field) => field.name)).toEqual(['id'])
  })

  it('falls back to the first field for a title that is not described, and skips a resource with no field', async () => {
    const noTitle: AppMetadata = {
      ...GENERATED,
      resources: GENERATED.resources.map((r) =>
        r.table === 'orders' ? { ...r, titleField: 'secret_note' } : r,
      ),
    }
    const manifest = await build(
      [
        resource('orders', ORDERS, allowAll),
        resource('customers', { ...CUSTOMERS, fields: [] }, allowAll),
      ],
      noTitle,
    )
    assertUiAccepts(manifest)
    expect(manifest.resources.map((r) => r.name)).toEqual(['Order'])
    expect(byName(manifest, 'Order')?.titleField).toBe('number')
  })

  it('leaves out a resource without a policy, or one the actor can do nothing with', async () => {
    const denyAll: Policy<unknown> = { viewAny: () => false, create: () => false }
    const manifest = await build(
      [resource('orders', ORDERS, undefined), resource('customers', CUSTOMERS, denyAll)],
      GENERATED,
    )
    expect(manifest.resources).toEqual([])
  })

  it('offers only what has a route: an index-only resource cannot be created or edited', async () => {
    const manifest = await build([resource('customers', CUSTOMERS, allowAll, ['index'])])
    expect(byName(manifest, 'Customer')?.capabilities).toEqual({
      list: true,
      view: false,
      create: false,
      update: false,
      delete: false,
      restore: false,
      export: false,
    })
  })

  it('never offers record actions to a guest unless before() allows them', async () => {
    const guestManifest = await buildAppManifest({
      app: { name: 'Northwind', apiVersion: '' },
      resources: [resource('customers', CUSTOMERS, allowAll)],
      metadata: undefined,
      user: null,
      now: () => new Date(),
    })
    expect(byName(guestManifest, 'Customer')?.capabilities).toMatchObject({
      list: true,
      view: true,
      create: true,
      update: false,
      delete: false,
    })
  })
})

describe('readAppMetadata and apiVersionOf', () => {
  /** A temporary app folder, with `.strutvane/resources.json` holding `content` when given. */
  const appWith = (content?: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'strut-manifest-'))
    folders.push(root)
    if (content !== undefined) {
      mkdirSync(join(root, '.strutvane'))
      writeFileSync(join(root, '.strutvane', 'resources.json'), content)
    }
    return root
  }

  it('reads a version-1 document and ignores a missing or malformed one', () => {
    expect(readAppMetadata(appWith())).toBeUndefined()
    expect(readAppMetadata(appWith('{not json'))).toBeUndefined()
    expect(readAppMetadata(appWith('{"version":2,"resources":[]}'))).toBeUndefined()
    expect(readAppMetadata(appWith('null'))).toBeUndefined()
    expect(readAppMetadata(appWith(JSON.stringify(GENERATED)))?.resources).toHaveLength(2)
  })

  it('names the API version only when the base path has one', () => {
    expect(apiVersionOf('/api')).toBe('')
    expect(apiVersionOf('/api/v1')).toBe('v1')
    expect(apiVersionOf('/api/v12/')).toBe('v12')
  })
})
