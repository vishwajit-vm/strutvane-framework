/**
 * Laravel's feature-test helpers for an `Application`: requests go straight into `app.handle()`
 * (no port, no network), so a test is fast and deterministic.
 *
 * ```ts
 * const response = await testClient(app).actingAs(user).postJson('/api/posts', { title: 'Hello' })
 * response.assertStatus(201).assertJsonPath('data.title', 'Hello')
 * ```
 *
 * `actingAs(user)` feeds the user the way the auth package's `http.onRequest` hook would, and
 * `withoutCsrf()` skips the CSRF check. Both are switches on the client, never headers, and the
 * app refuses them unless `APP_ENV=testing` (CONSISTENCY #60), so nothing a real client sends can
 * use them.
 *
 * @module
 */
import type { Actor } from '../contracts/actor.ts'
import type { Application } from '../foundation/application.ts'
import type { AuthUser } from '../foundation/registry.ts'

/** Switches that change how the test client talks to the app (not headers a browser could send). */
interface ClientOptions {
  readonly withoutCsrf: boolean
  readonly actor: Actor | object | undefined
  readonly ip: string
}

/**
 * A request builder for one app.
 *
 * @example
 * await testClient(app).getJson('/api/posts')
 */
export function testClient(app: Application): TestClient {
  return new TestClient(app, {}, { withoutCsrf: false, actor: undefined, ip: '203.0.113.10' })
}

/**
 * Builds and sends requests. Immutable: every `with…()` returns a new client.
 *
 * @example
 * const asAlice = testClient(app).actingAs(alice)
 */
export class TestClient {
  readonly #app: Application
  readonly #headers: Readonly<Record<string, string>>
  readonly #options: ClientOptions

  constructor(app: Application, headers: Readonly<Record<string, string>>, options: ClientOptions) {
    this.#app = app
    this.#headers = headers
    this.#options = options
  }

  /**
   * Skip the CSRF check for this client's requests, Laravel's `withoutMiddleware(VerifyCsrfToken)`.
   * Only works when APP_ENV=testing: the app refuses the request otherwise.
   *
   * @example
   * await testClient(app).withCookie('strutvane_session', 'abc').withoutCsrf().postJson('/api/posts', body)
   */
  withoutCsrf(): TestClient {
    return new TestClient(this.#app, this.#headers, { ...this.#options, withoutCsrf: true })
  }

  /**
   * Send requests as this user, Laravel's `actingAs($user)`: the user is handed to the request
   * the way the auth hook would resolve it (`ctx.user`). Only works when APP_ENV=testing.
   *
   * @example
   * testClient(app).actingAs({ id: '7', type: 'user', roles: [], attrs: {} }).getJson('/api/me')
   */
  actingAs(user: AuthUser | Actor): TestClient {
    return new TestClient(this.#app, this.#headers, { ...this.#options, actor: user })
  }

  /**
   * Add headers to every request.
   *
   * @example
   * testClient(app).withHeaders({ origin: 'https://evil.example' })
   */
  withHeaders(headers: Readonly<Record<string, string>>): TestClient {
    return new TestClient(this.#app, { ...this.#headers, ...headers }, this.#options)
  }

  /**
   * Send a cookie with every request.
   *
   * @example
   * testClient(app).withCookie('strutvane_session', 'abc')
   */
  withCookie(name: string, value: string): TestClient {
    const existing = this.#headers['cookie']
    const cookie = `${name}=${value}`
    return this.withHeaders({ cookie: existing === undefined ? cookie : `${existing}; ${cookie}` })
  }

  /**
   * Send requests from this socket address (default `203.0.113.10`).
   *
   * @example
   * testClient(app).fromIp('2001:db8::1')
   */
  fromIp(ip: string): TestClient {
    return new TestClient(this.#app, this.#headers, { ...this.#options, ip })
  }

  /**
   * `GET` with `Accept: application/json`.
   *
   * @example
   * await client.getJson('/api/posts')
   */
  getJson(path: string): Promise<TestResponse> {
    return this.send('GET', path, undefined)
  }

  /**
   * `POST` a JSON body.
   *
   * @example
   * await client.postJson('/api/posts', { title: 'Hi' })
   */
  postJson(path: string, body: unknown): Promise<TestResponse> {
    return this.send('POST', path, body)
  }

  /**
   * `PATCH` a JSON body.
   *
   * @example
   * await client.patchJson('/api/posts/1', { title: 'Hi' })
   */
  patchJson(path: string, body: unknown): Promise<TestResponse> {
    return this.send('PATCH', path, body)
  }

  /**
   * `PUT` a JSON body.
   *
   * @example
   * await client.putJson('/api/posts/1', { title: 'Hi' })
   */
  putJson(path: string, body: unknown): Promise<TestResponse> {
    return this.send('PUT', path, body)
  }

  /**
   * `DELETE`.
   *
   * @example
   * await client.deleteJson('/api/posts/1')
   */
  deleteJson(path: string): Promise<TestResponse> {
    return this.send('DELETE', path, undefined)
  }

  /**
   * `GET` as a browser would (HTML accepted).
   *
   * @example
   * await client.get('/')
   */
  get(path: string): Promise<TestResponse> {
    return this.#dispatch(
      new Request(`http://localhost${path}`, {
        headers: { accept: 'text/html', ...this.#headers },
      }),
    )
  }

  /**
   * `POST` a urlencoded form, as an HTML form does.
   *
   * @example
   * await client.postForm('/posts/7', { _method: 'DELETE', _token: token })
   */
  postForm(path: string, fields: Readonly<Record<string, string>>): Promise<TestResponse> {
    return this.#dispatch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          accept: 'text/html',
          'content-type': 'application/x-www-form-urlencoded',
          ...this.#headers,
        },
        body: new URLSearchParams(fields).toString(),
      }),
    )
  }

  /**
   * Any method and body (a string is sent as is, anything else as JSON).
   *
   * @example
   * await client.send('POST', '/api/posts', '{"title": ')
   */
  send(method: string, path: string, body: unknown): Promise<TestResponse> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.#headers }
    if (body !== undefined) headers['content-type'] ??= 'application/json'
    const init: RequestInit =
      body === undefined
        ? { method, headers }
        : { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) }
    return this.#dispatch(new Request(`http://localhost${path}`, init))
  }

  /**
   * Send a ready-made request.
   *
   * @example
   * await client.request(new Request('http://localhost/up', { method: 'HEAD' }))
   */
  request(request: Request): Promise<TestResponse> {
    return this.#dispatch(request)
  }

  async #dispatch(request: Request): Promise<TestResponse> {
    const testing = {
      ...(this.#options.withoutCsrf ? { withoutCsrf: true } : {}),
      ...(this.#options.actor === undefined ? {} : { actor: this.#options.actor }),
    }
    const response = await this.#app.handle(request, {
      ip: this.#options.ip,
      ...(Object.keys(testing).length === 0 ? {} : { testing }),
    })
    return new TestResponse(response.status, response.headers, await response.text())
  }
}

/**
 * A received response with Laravel-style assertions. Each failure message shows the body, so a
 * failing test explains itself.
 *
 * @example
 * response.assertStatus(200).assertJsonPath('data.title', 'Hello')
 */
export class TestResponse {
  readonly status: number
  readonly headers: Headers
  readonly text: string

  constructor(status: number, headers: Headers, text: string) {
    this.status = status
    this.headers = headers
    this.text = text
  }

  /**
   * The body parsed as JSON.
   *
   * @example
   * response.json
   */
  get json(): unknown {
    return JSON.parse(this.text)
  }

  /**
   * Fail unless the status matches.
   *
   * @example
   * response.assertStatus(201)
   */
  assertStatus(expected: number): this {
    if (this.status !== expected)
      throw new Error(
        `Expected status ${expected}, got ${this.status}. Body: ${this.text.slice(0, 2000)}`,
      )
    return this
  }

  /**
   * Fail unless the value at a dot path equals `expected` (deep equality via JSON).
   *
   * @example
   * response.assertJsonPath('meta.total', 3)
   */
  assertJsonPath(path: string, expected: unknown): this {
    const actual = this.path(path)
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `Expected ${path} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}. Body: ${this.text.slice(0, 2000)}`,
      )
    return this
  }

  /**
   * Fail unless this is a problem+json with the given status and code.
   *
   * @example
   * response.assertProblem(422, 'VALIDATION_FAILED')
   */
  assertProblem(status: number, code: string): this {
    this.assertStatus(status)
    if (!(this.headers.get('content-type') ?? '').includes('application/problem+json'))
      throw new Error(
        `Expected problem+json, got ${this.headers.get('content-type') ?? 'no content type'}.`,
      )
    return this.assertJsonPath('code', code)
  }

  /**
   * The value at a dot path (`data.0.title`), for custom assertions.
   *
   * @example
   * const titles = response.path('data')
   */
  path(path: string): unknown {
    let current: unknown = this.json
    for (const segment of path.split('.')) {
      if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment))
        return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    return current
  }
}
