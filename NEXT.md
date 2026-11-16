# v2/app-core: where the port stands

Working notes for the spike 12 port (MVC app core + Laravel-style commands). Delete before merge.

## Done (tests green: tsc clean, biome clean, test/http + storage + security + runtime + core + app + routing + foundation pass)
- Foundation: `BootError`, class injection over the core container, current-application context,
  `Application.configure()…create()` (bootstrap/app.ts), typed config/env, providers (objects and
  classes), helpers (`route`, `config`, `app`, `now`, `redirect`), registries, navigation, listener
  discovery, bootstrap caches, `loadApplication(root)`.
- Routing: `Route.*`, callback route files and groups (#46, #106), resource/apiResource, singleton,
  shallow, fallback, `_method` spoofing (POST only), typed `route()`, `url.signedRoute()` /
  `temporarySignedRoute()` (#52, #65), `/up` (#45).
- HTTP kernel (`src/http/app/`): HttpContext, middleware in every style (#16, #106), protections
  (csrf, auth, can, throttle, signed, idempotent) reusing the fix-pass CSRF/hosts/idempotency,
  policies with auto-discovery (#73), defer/terminable middleware, ResourceController over a
  `ResourceModel` interface, FormRequest, test client.
- Security kit (`src/security/`): keyring with `derive(purpose)` + `APP_PREVIOUS_KEYS` (#66), one
  signer (#64), AES-GCM with full 16-byte tags, CSP-nonce security headers, trusted proxies (CIDR),
  SSRF-safe `HttpClient` with `fake()`, CORS, redirect guard, boot guards, settings.

## Next
1. Commands: optimize, config/route/event cache+clear, event:list, cache:clear/forget, key:rotate,
   env:encrypt/decrypt, down/up (all options) + maintenance stage, session:flush, security:check,
   route:list --security, make:command/rule/observer, list. All text says `node strut` (#127).
2. Exception handler + dev error page ("Copy as Markdown for AI"); swap into `Application`.
3. Facades (#47, #80) resolved from the current app container; unbuilt ones throw "coming in 0.3".
4. Error codes to lowercase snake_case with a one-minor compatibility window (#123); issue shape
   `{ path, field, code, message }` (#69).
5. Wire catalogs into `src/messages.ts`, exports in `src/index.ts`, Node adapter passes `{ ip, waitUntil }`.
6. Minor changeset (#128), docs, full gate 3x, R1/R5 checks.

## Exceptions + facades (WIP, paused 2026-11-16)
- Done: `src/exceptions/` (ExceptionsConfig: dontReport, report/render global or per class,
  shouldRenderJsonWhen, throttle; ExceptionHandler; debug page + "Copy as Markdown for AI" +
  JSON `debug` member, redaction, app-only frames, nonce CSP; `report()` + ExceptionHandlerToken),
  wired into `Application` (temporary renderer removed from `http/app/errors.ts`; routed ctx is now
  the current HttpContext). `src/facades/` (Log, Cache, DB, Route, Storage, Http, Event, Crypt, Url;
  Mail/Queue/Bus/Notification/Hash throw `facade_not_available`). Tests: test/exceptions (45),
  test/facades (10 + type tests); test/app green after one test asked for JSON explicitly.
- Half-done: last `npx biome check` on these paths reported an error not yet inspected (re-run
  `npx biome check src/exceptions src/facades test/exceptions test/facades`); last edits (debug-page
  fail-closed fallback + its test) not re-run; coverage of src/exceptions + src/facades not measured.
- Next: fix lint, run test/exceptions test/facades test/app, measure coverage; export from
  `src/index.ts` (exceptions) and add a `./facades` subpath (Route facade must not shadow the
  routing `Route` builder); no new catalog codes (500s use core INTERNAL_ERROR).
