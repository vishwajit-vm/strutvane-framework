/**
 * `@strutvane/framework/testing`: helpers for testing Strutvane apps against a real database.
 *
 * @packageDocumentation
 */
// The v2 feature-test client for an Application (`testClient(app).actingAs(user).getJson(…)`).
// Its classes are exported as AppTestClient/AppTestResponse: TestClient and TestResponse name the
// v1 createTestApp() types below.
export {
  TestClient as AppTestClient,
  TestResponse as AppTestResponse,
  testClient,
} from './app-client.ts'
export {
  createFake,
  type DefinedFactory,
  defineFactory,
  type FactoryAttributes,
  type FactoryHelpers,
  type FactoryTarget,
  type Fake,
  type RelatedMarker,
  type RelatedOptions,
} from './define-factory.ts'
export { createFactory, type Factory, fakeValue, type RepositoryLookup } from './factory.ts'
export {
  createTestApp,
  type ResourceClient,
  type TestApp,
  type TestAppOptions,
  type TestClient,
  type TestRequestInit,
  type TestResponse,
} from './test-app.ts'

import type { AnyModel } from '../model/define-model.ts'
import type { Factory } from './factory.ts'
import type { TestApp } from './test-app.ts'

/** `factory(t, Invoice)`: shorthand for `t.factory(Invoice)`. */
export function factory<M extends AnyModel>(
  app: TestApp,
  model: M,
  options?: { readonly tenantId?: string },
): Factory<M> {
  return app.factory(model, options)
}

/** `refreshDatabase(t)`: shorthand for `t.refreshDatabase()`. */
export function refreshDatabase(app: TestApp): Promise<void> {
  return app.refreshDatabase()
}

/** `actingAs(t, actor)`: shorthand for `t.actingAs(actor)`. */
export function actingAs(
  app: TestApp,
  ...args: Parameters<TestApp['actingAs']>
): ReturnType<TestApp['actingAs']> {
  return app.actingAs(...args)
}
