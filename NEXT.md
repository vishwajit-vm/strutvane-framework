# v2/app-runtime: a generated app runs end to end (demo acceptance blockers)

Branch `v2/app-runtime`, cut from `v2/gaps` b0de9ca, with `v2/logging` f3e28b8 **merged** (not
rewritten). Not pushed by the agent; the coordinator pushes. Evidence: `strutvane-demo/ACCEPTANCE.md`.

## Done (each with tests that fail on 0.2.0-next.1)
- **FW-1 / FW-2** `dev` and `build` boot `bootstrap/app.ts` (no `strutvane.config.ts` needed); `dev`
  mounts the project's Vite on the app port. `test/runtime/app-runtime.test.ts`.
- **FW-3** `start` serves `dist/web` (static + SPA fallback, caching, page CSP) via the new
  `Application.serveUi()`; routes and hooks win; API paths stay problem+json. Same file.
- **FW-6** `GET /.well-known/strutvane.json` from the application (`src/http/app/manifest.ts`):
  resources = `ResourceController` routes under the API base; fields from `.strutvane/resources.json`;
  per-actor capabilities from the API's own policies; nothing for an actor who may do nothing.
  `test/app/manifest.test.ts`.
- **FW-8** logs to `storage/logs`: merged `v2/logging` (its own NEXT section below still applies:
  its gate never had a green run before the merge).
- **FW-9** maintenance 503 not reported as an error. `test/exceptions/handler.test.ts`.
- **FW-11** `doctor` (app boots, resources.json, unregistered add-on providers = AUTH-2 in v2 terms),
  `models`, `permissions`, `registry:build` on an application. `test/commands/app-inspect.test.ts`.
- **FW-14** `node strut design:use <crisp|vivid>`. Same file.
- **DOCK-2** cause (verified): with no `publicUrl`, the Node adapter built request URLs from the bind
  address, so `0.0.0.0` became `ctx.state.host` and failed the trusted-host check. Request URLs now
  use loopback for a wildcard bind; the `Host` header is still checked against loopback, the
  `APP_URL` host and `trustedHosts`. The bind comes from `--host`, `config('app.host')` or `APP_HOST`
  (the installer's compose file already sets `APP_HOST=0.0.0.0`).

## URL contract (framework ↔ ui ↔ auth), and what the UI must change for UI-1
- API base = the app's `apiPrefix`: **`/api`** by default (CONSISTENCY #33, which wins over the
  `/api/v1` in docs/05 §1 and in this agent's brief: **conflict reported, not silently resolved**;
  an app may opt into `/api/v1` with `withRouting({ apiPrefix: '/api/v1' })`).
- Manifest: the origin's `/.well-known/strutvane.json`, whatever the API base. `app.apiVersion` is
  the base's version segment (`''` for `/api`, `v1` for `/api/v1`). Resource `path` is relative
  to the API base (`customers` → `/api/customers`).
- Auth: `{API base}/auth/*`, i.e. `/api/auth/*` by default (auth's AUTH-1 fix: drop the `v1` default).
- **UI changes for UI-1:** none needed for the manifest URL (`fetchManifest` resolves the absolute
  `MANIFEST_PATH` against the origin); keep `apiUrl="/api"` in the skeleton's `main.tsx`.
  To check on the ui side: (1) filter operator `null` in resources.json is published as
  `isNull` + `isNotNull`: the list-query URL the UI builds must match the v2 API's
  `?filter[field][op]=` syntax (data-crud agent owns that side); (2) UI-2: only call
  `/auth/tenants` when tenancy is on; (3) the manifest may list zero resources (no resource routes
  until FW-4/FW-5 land): show the shell, not an error.

## Notes for other agents
- **skeleton:** `routes/web.ts` registers `/` (welcome), which wins over the UI's `/`; with `--ui
  admin` drop it (or redirect) so `/` is the admin home. Optional `host: env.string('APP_HOST', '')`
  in `config/app.ts` (the framework reads `APP_HOST` without it).
- **installer:** `design:use` now exists (INST-2 can stay). Still missing from the installer's text:
  `install:<name>` (`add` exists), `services:*`, `docker:prod`, `db:prepare`, `shell`, `setup`
  (check which are the installer's own `strut.js` commands before dropping them).
- **FW-13** (`migrate`'s v1 description) left alone: `migrate` belongs to `v2/data-crud`.

## DOCK-1 options (decision for the lead; the ownership check is unchanged)
1. Trust the project root when `STRUTVANE_IN_CONTAINER=1` **and** the root is the compose
   `working_dir` (`/app`) **and** the process is not root: narrow, but an env var is the gate.
2. Installer writes `STRUT_UID=0`/`STRUT_GID=0` on Windows hosts (the workaround used): no
   framework change, but disables the check entirely in those containers.
3. Keep the app on a named volume inside the container (also fixes DOCK-3 slowness); the bind mount
   only for source sync. Most work, safest.

## Next
- Scope addition from the coordinator (6 items) is in progress below this list, see "Hardening".
- Full gate 3x, then the coordinator re-runs and pushes.

# v2/gaps: what add-ons and the docs agent hit in 0.2.0-next.1

Branch `v2/gaps` (from `main` 8b896f0, `main` e395315 merged in). Not pushed by the agent; the
coordinator pushes. Evidence: the NEXT.md files of redis, search, social-login, log-viewer,
import-export and health (their `v2/*` branches).

## Done (each with tests that fail on 0.2.0-next.1)
- **A. Extension points** (`test/foundation/extension-points.test.ts`, `test/devkit/app-patcher.test.ts`,
  `test/database/orm/events.test.ts`, app-level event test in `test/database/orm/app-database.test.ts`):
  - root exports: `allows`, `authorize`, `hasAdminRole`, `Policy`, `PolicyDenial`, `PolicyRegistry`
    (+ `registry.allows()`/`authorize()`, deny without a policy), `PolicyRegistryToken`,
    `RateLimitStoreToken`, `UsedSignatureStoreToken`, `MemoryUsedSignatureStore`, `MemoryCacheStore`;
    `AuthUser` was already there. `/testing`: `testClient` (+ `AppTestClient`, `AppTestResponse`).
  - model events `<model>.created/.updated/.deleted/.restored` as **domain events on the app's
    EventBus, after commit** (dropped on rollback), with tenant + actor; `modelEventName()`;
    `afterCommit()` / `Connection.afterCommit()` (`/database`).
  - `app.env(name)` (merged env, readable in `register()`); `app.config()` works there too.
  - `app.addMessages(...catalogs)`: live package layer under app + built-in messages.
  - `CacheDriverRegistryToken` (`extend('redis', factory)`), stores pass their whole entry.
  - devkit `createAppPatcher` / `context.app` for `bootstrap/providers.ts` + `config/index.ts`
    (AST-located, idempotent, reversible, fail-safe with printed manual lines).
- **B. Storage** (`test/storage/public-disk.test.ts`, `test/commands/storage-link.test.ts`):
  `config/filesystems.ts` read at boot, public disks served at their url path (`/storage/...`),
  `node strut storage:link [--force]`. Also fixed: active content with a parametrised/odd-case type
  was served inline by signed links (`isActiveContent`, regression test in `hardening.test.ts`).
- **C. Docs-agent bugs** (`test/commands/docs-agent-bugs.test.ts`, `test/console/make-migration-first.test.ts`):
  `--force-debug` on start/dev, 415 `{expected}`, `route:list` `throttle:60,1`, Schema/Migration/
  Sandbox errors keep their hint in the CLI, `make:model/factory/seeder` write v2 shapes,
  `app.previous_keys: env.optional(...)` unset no longer reads as "undefined".
- **D.** 5 changesets (4 minor, 1 patch; pre `next`, `changeset version` NOT run), README
  ("Storage", "For package authors: extension points").

## Integration-map rows the hub needs (docs/17; describe only, the hub owns the map)
- §3 tokens: `CacheDriverRegistry` (framework; redis adds `redis`), `RateLimitStore` and
  `UsedSignatureStore` (framework default memory/cache; redis may replace), `PolicyRegistry`
  (framework; add-ons such as search read the app's policies), `MessageCatalog` row: packages
  register through `app.addMessages()`.
- §5 domain events: `<model>.created/.updated/.deleted` emitted by the framework already listed; add
  `.restored`, and note they are delivered **after commit** (in-process bus; the outbox is later).
- §6.1 / installers: `context.app` (devkit) edits `bootstrap/providers.ts` and `config/index.ts`.

## Deferred (and why)
- A richer session-driver contract for redis (`read/write/touch/destroy`): not in this brief; needs
  an RFC because auth consumes it.
- Provider-registered commands in the CLI (follow-up 2 below) and request logging (log-viewer's
  proposal): separate work.
- Add-on repos still carry their own patch helpers until they move to `context.app`.

## Gate (2026-11-20, Windows, Node 24, at b5c4317; agent-reported until the coordinator re-runs)
- `npm ci`, then `npm run ci` 3x in a row: each 3,221 passed / 17 skipped, coverage above
  90/90/85/90 (run 1: 96.36/90.74/97.28/97.36), no unhandled rejections.
- An earlier run found an unhandled rejection in the new events test (a test-only race, fixed in
  b5c4317); nothing was weakened.
- check-code-rules, check-deps, pack + check-package (187 files), publint 0.3.25 --strict,
  attw 0.18.5 esm-only: all pass. `npm audit --omit=dev --audit-level=high`: exit 0 (4 moderate,
  esbuild's dev server, unchanged from main).

## Next
- Coordinator: re-run the gate, push, review; `changeset version` only at release time.
- Hub: the integration-map rows above. Add-ons: move their patch helpers to `context.app`, use
  `app.env()`, `app.addMessages()`, `CacheDriverRegistryToken`, model events and `afterCommit()`.

## How to verify
Same as below ("How to verify"): `npm ci`, `npm run ci` 3x, code-rules/deps/package checks,
publint --strict, attw, `npm audit --omit=dev --audit-level=high`.

# v2/merge-0.2: what is left after the merge

# v2/logging: logging moves into the framework (ADR-0022)

Branch `v2/logging`, cut from `main` at 6dfc239 (0.2.0-next.0). Source of the port: the logs repo
(GitHub `strutvane-log-viewer`), branch `v2/channels` at 2607bff. Not pushed, not merged.

## Done
- `src/logging/`: the `v2/channels` pipeline (levels, record, context, sanitiser, serialiser,
  bounded queue, sink, emitter, manager, config, `line`/`json` formats and parser, file naming,
  retention, reading, file/console/slack transports, shutdown flush, no-op logger) and the pure
  parts of `log:tail/list/clear` (`commands/`). Viewer, request-logging adapters and the global
  lazy `Log` stay in log-viewer.
- Reuse instead of copies: key matching from `core/logger/serialize.ts`; the secret patterns moved
  to `core/logger/redact-patterns.ts` (now also used by core's fallback logger and the error page);
  escaping (C1, U+2028/9 and, new, bidi controls) in `core/logger/escape.ts`; the slack webhook
  posts through `security/http-client.ts` `safeFetch` (`logging/net/webhook.ts`), which gained
  the 6to4 relay range the logs client blocked.
- Path traversal: `logDirectory()` refuses relative log paths that climb out of the project and
  filesystem roots (`LOG_PATH` warns and falls back; config and `Log.build` throw).
- Application: `LogManagerToken` + `LoggerToken` bound in the constructor (lazy, built from
  `config/logging.ts` and the app's env at boot; disposed = drained, 2 s, last step of shutdown),
  a log scope per request (`runWithLogContext`), request/trace/user/tenant ids from core's request
  context, `app.loggingConfig()` (no boot) for the commands.
- `Log` facade (all RFC 5424 levels + aliases, `log`, channels, stacks, `build`, context helpers,
  `deprecation`, `manager`), `logger()`; `report()` unchanged (exception handler → logger).
- Console: `log:tail`, `log:list`, `log:clear` (`src/console/commands/app/logs.ts`).
- Public entry `./log` (`src/logging/index.ts`), README section, changeset `v2-logging.md`.
- Tests: `test/logging/` (ported suites + `app.test.ts`, `log-commands.test.ts`,
  `injection.test.ts`); `logger.perf.test.ts` runs under `npm run test:perf`.

## Half-done / next (stopped for the usage limit, 2026-11-18)
- Nothing half-written in the code: every change is committed. What is missing is evidence.
- Next, in order: the gate 3× in a row on a quiet machine (see "Gate status": no green run yet),
  then `npm run test:perf`, `check-code-rules` + `check-deps` (both passed on 2c60013),
  `npm pack` + `check-package`, publint `--strict`, attw `--profile esm-only` (the new `./log`
  subpath is not checked yet), `npm audit --omit=dev --audit-level=high`.
- Look at coverage for `src/logging/**` and `src/console/commands/app/logs.ts` in the first green
  run (no run reached the coverage report yet).
- `test/logging` is its own Vitest project (serial, after the framework project): its deadline and
  child-process suites failed only under CPU contention when they ran in parallel with the
  database suites.

## Decisions for the project lead
1. Default output changes: apps now log to `storage/logs/strutvane-YYYY-MM-DD.log` (ADR-0022
   defaults) instead of JSON on stdout, boot warnings included.
2. Request logging (one line per HTTP request, RFC-0004 §1) is not ported: it was an adapter of the
   logs provider. Port it as a framework `http.onResponse` hook, or leave it to log-viewer?
3. `log:clear` is not marked `destructive` (no production `--force --i-understand` guard); it asks,
   or needs `--force`/`--yes`, as the logs CLI did.
4. A `custom` channel can't survive `config:cache` (functions aren't JSON): the boot fails with
   `invalid_logging_config` instead of dropping it silently.

## Follow-ups carried over from v2/merge-0.2 (not in 0.2.0-next.0)
1. Before the generated CRUD API (v2 HTTP layer) calls the ORM: an allow-list for request-driven
   `?include=` relation names, and opt-in totals plus an offset cap for `paginate()` (hub `docs/12`
   §3.2).
2. Commands a service provider registers in `register()` are not in the CLI yet (it would need a
   boot per CLI call); an app's own `withCommands()` commands are.
3. Node 24 has no `--allow-net`: the replay sandbox closes the network with in-process barriers
   there. Revisit when the minimum Node version moves.

## fix/ci-cross-platform (Windows and macOS CI for 0.2.0-next.0)
- **Done:**
  - The real-server global setup (`test/helpers/db-servers.ts`) needs Docker with Linux
    containers. A server that can't start is skipped, with the reason in the test title.
    `STRUTVANE_TEST_DOCKER=require` and Linux CI still fail loudly.
  - `realRoot()` resolves the project root once, which fixes the macOS `/var` → `/private/var`
    failures. Linked-root suites cover this on every OS (a junction on Windows).
  - The idempotency TTL test uses `createTestApp({ clock })`.
  - The Biome reflow tests get 90 s per call.
- **Left:** push the branch, confirm the Windows and macOS CI jobs, then merge into `main`. On
  Windows the real-server suites are skipped by design: GitHub's Windows runners only have
  Windows containers.

## How to verify
```bash
npm ci
npm run ci        # 3x in a row; needs Docker for the MySQL/MariaDB/PostgreSQL suites
npm run test:perf # the logging benchmark budgets (quiet machine)
node .github/scripts/check-code-rules.mjs && node .github/scripts/check-deps.mjs
npm pack --pack-destination ../pack && node .github/scripts/check-package.mjs
npm exec --yes --package=publint@0.3.25 -- publint run ../pack/*.tgz --strict
npm exec --yes --package=@arethetypeswrong/cli@0.18.5 -- attw ../pack/*.tgz --profile esm-only
npm audit --omit=dev --audit-level=high
```

## fix/release-0.2 (0.2.0-next.0 release blockers from the skeleton; branched from fix/ci-cross-platform)
Stopped 2026-11-18 at the usage limit; not pushed. Commits: compat 8e88e94, replay timeout 2ec0b7a,
Application database 2cd9d0b, ConfigOf/RoutesOf e937372, then this WIP commit (resources.json).
- **Done (committed, targeted suites green; full gate NOT run yet):**
  1. compat `^0.2.0-next.0`; CLI never refuses itself; hints derive the range from the CLI version
     (`compatRangeFor`); `test/console/compat.test.ts` (verified red on the old range).
  2. Application database: lazy `DatabaseConnectionToken` from config/database.ts over DB_*,
     schema.json + tenancy at boot, `runWithConnection` per request/command, tenant scope per
     request, closed on shutdown. `test/database/orm/app-database.test.ts` green on SQLite,
     PostgreSQL, MySQL, MariaDB; `test/database/lazy-driver.test.ts`, `test/foundation/database.test.ts`.
  4. `ConfigOf`/`RoutesOf` exported; public-entry tsc test (verified red without) + test-d.
  5. `--replay-timeout` / `DB_MIGRATION_REPLAY_TIMEOUT` (1 s..10 min, default 10 s);
     `test/runtime/replay-timeout.test.ts`. Changesets for 1, 2, 4, 5; README updated.
- **Done: 3. resources.json** (WIP 2492d9f + follow-up): `INTERNAL_TABLES` shared with the resource
  controller, model-derived fillable/hidden (`model-options.ts`), real primary key;
  `test/schema/resources-from-models.test.ts` green. **Decision (coordinator, 2026-11-18): `users`
  and `teams` stay on INTERNAL_TABLES (F-01 wins); auth provides its own users screen.** Documented
  in README.
- **Next:** the gate:
  `npm run ci` 3x (≈8.5 min each; baseline was green apart from a failure caused by a mid-run
  edit), once with `STRUTVANE_TEST_DOCKER=off`; code rules, deps, pack + check-package, publint
  --strict, attw esm-only, `npm audit --omit=dev --audit-level=high` (commands in "How to verify"
  above). Skeleton follow-ups: delete its `acceptCompatOnce()` + KNOWN BUG test; regenerate its
  .strutvane (users now internal); add `DB_MIGRATION_REPLAY_TIMEOUT` to its .env.example/config.

## Gate status (agent-reported)
- Run 1 (2c60013): 1 failed (a test expectation in injection.test.ts, fixed in 2b3af55), 3459
  passed, 17 skipped; 12m44s.
- Run 2 (2b3af55): 45 failed, all timeouts in the database/pglite/console suites while another
  agent's test run (its own DB containers) held the CPU at 99%; no logging test failed. Not a
  code failure, but it breaks the 3× streak: rerun on a quiet machine.
- Run 3 (49b9a9f): 22 failed, again timeouts and "failed to start forks worker" in the database,
  ORM and console suites (110 min; machine overloaded); no logging test failed.
- Run 4 (49b9a9f, machine quiet): stopped by the coordinator (usage limit) before it finished;
  its vitest process was killed and its three DB containers (`…-16292-…`) were removed.
- The changed logging suites alone, serially (`--no-file-parallelism`): 7 files, 68 passed, 1
  skipped.
