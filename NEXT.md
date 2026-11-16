# v2/app-core: where the port stands

Working notes for the spike 12 port (MVC app core + Laravel-style commands). Delete before merge.

## Overall state (paused 2026-11-16, coordinator)
- Lint is clean. `tsc` has ONE error, in `test/commands/caches.test.ts:135` (a `RouteList<unknown>` that is
  assigned to a typed list; fix the fixture's type). The full gate (`npm run ci`) has NOT been run on this
  branch. Last green targeted runs: test/http + storage + security + runtime + core (704 tests),
  test/app + routing + foundation (190), test/exceptions (45), test/facades (10), test/console (380).
- Baseline on main before the port: 1465 passed, 1 failed (`test/runtime/serve-lifecycle.test.ts`
  "a request that outlives the grace period is cut off": a load-sensitive timing test, flaky under load;
  it must be made deterministic for the "3 green runs under load" gate).
- Not started: the lowercase error-code migration (#123) and the issue `field` member (#69); wiring the
  APP_/SECURITY_/MAINTENANCE_/CACHE_ catalogs into `src/messages.ts` (Application registers APP_ and
  SECURITY_ itself for now); `src/index.ts` exports + `./facades` subpath; `route` swap to
  `routing/route-helper.ts` in `src/index.ts`; the Node adapter (`src/runtime/serve.ts`) passing
  `{ ip, waitUntil }` and booting `bootstrap/app.ts`; `createHttpApp`/`serve.ts` switching to
  `resolveTrustProxy` (list-form `trustProxy` throws in `trustedHops` today); the CLI changes listed in
  the commands section; the minor changeset (#128); docs/README; R1/R5 checks; the gate 3 times.
- Decisions for the lead: generated apps must not set `isolatedDeclarations` (typed route()/config() need
  `typeof web`); `route:list` is the app command and `routes` stays for strutvane.config.ts projects;
  HSTS is now production-only in `securityHeaders()` once `createHttpApp` passes `environment`;
  an unsafe request with a session cookie to an unknown path answers 419 (CSRF runs before routing).

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

## Commands, maintenance, cache and session stores (WIP, paused 2026-11-16)
- Committed in c22065b (swept into the exceptions commit through the shared index; all files are mine
  except src/exceptions, src/facades, src/http/app/errors.ts and their tests).
- Done (tsc + biome clean on these paths, test/console still green, 380 tests):
  - `src/maintenance/` (state.ts: stat-cached state file, corrupt = down, fields re-checked;
    maintenance.ts: `checkMaintenance` bound as default `MaintenanceCheckToken`, secret HMAC under
    `derive('maintenance')`, bypass cookie bound to the secret, verified with every key, /up open;
    page.ts: `--render` path checks; catalog.ts: `maintenance_mode` 503).
  - `src/cache/` (file-lock.ts O_EXCL per-key lock with stale takeover + 503 `cache_unavailable`;
    file-store.ts; store.ts `createCacheManager` from config/cache.ts, bound as default
    `CacheManagerToken`; catalog.ts). `src/session/file-store.ts` bound as default `SessionStoreToken`.
  - `src/support/env-file.ts`; `src/console/commands/app/*` spread into BUILTIN_COMMANDS as
    `APP_COMMANDS` (optimize, optimize:clear, config/route/event cache+clear, event:list,
    cache:clear/forget, key:rotate, env:encrypt/decrypt, down/up, session:flush, security:check
    [--audit], route:list [--security], make:command/rule/observer); `--force-debug` is a per-command
    flag on booting commands; key:generate finds v2 apps and says `node strut`.
- Half-done: tests. Only test/commands/helpers.ts + caches.test.ts are written and NOT run yet.
- Next:
  1. Run `npx vitest run test/commands --coverage.enabled=false`, fix.
  2. Write test/commands/{cache-store,keys,maintenance,security,make}.test.ts (port spike 12
     commands.test.ts: env crypt round trip/wrong key/4-8-12 byte tags, key rotation keeps old
     ciphertexts + signed links, down retry/refresh, /up, bypass cookie, 9 hostile --redirect values,
     --render checks, corrupt state, real multi-process down/up via `writeRealApp` + spawned
     `node -e "import main…"`, cross-process file-cache increment, session:flush, security:check
     pass/production failures/refused boot/--audit with fakeSpawner, make:* outputs compile with tsc).
  3. Coverage of my files (aim 95/90).
- Needs a decision / files I don't own:
  - `src/console/project/project.ts` findProjectRoot: also accept `bootstrap/app.ts`/`strut.js` as a
    project marker, else v2 apps get no `.env` APP_ENV for the production guard.
  - `src/console/framework/run.ts`: `words[0] === 'help' || words[0] === 'list'` (CONSISTENCY #13).
  - `src/console/framework/errors.ts` toFailure: handle BootError (code, message, hint); my
    `defineAppCommand` converts it meanwhile. CLI catalog/help still say `sv` (#127).
  - Wire MAINTENANCE_/CACHE_ catalogs into src/messages.ts; merge `app.commands` into the CLI.
