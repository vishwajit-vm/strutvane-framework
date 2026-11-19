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

## How to verify
Same as below ("How to verify"): `npm ci`, `npm run ci` 3x, code-rules/deps/package checks,
publint --strict, attw, `npm audit --omit=dev --audit-level=high`.

# v2/merge-0.2: what is left after the merge

`v2/app-core` and `v2/data-layer` merged into one release candidate for `@strutvane/framework`
0.2.0-next.0 (lockstep core train, CONSISTENCY #128). Status and gate evidence: hub `STATE.md`.

## Follow-ups (not in 0.2.0-next.0)
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
