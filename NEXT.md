# v2/queues: queues and background work (0.3, RFC-0006)

Branch from `main` e395315. Design: hub `docs/rfcs/0006-queues-and-background-work.md` (Draft, hub
commit 01f1f6a). Never merged or pushed by the implementing agent.

## Done
- Contract types in `src/contracts/queue.ts` (`QueueDriver`, `ReservedJob`, `PushOptions`,
  `QueueLockStore`): the `@strutvane/redis` proposal plus optional `id` (idempotent push),
  `extend`, `close`.
- `src/queue/`: `errors.ts` (`QueueError`, lowercase codes + hints), `payload.ts` (plain-data and
  secret-key checks, canonical JSON, HMAC-signed envelope, prototype-pollution refusal), `job.ts`
  (`defineJob`, `JobCall`, options, `backoffDelay`), `registry.ts`, `tokens.ts`, `events.ts`,
  `runner.ts` (one attempt: tenant, scope, timeout + abort signal), `manager.ts` (connections,
  dispatch, afterCommit hook point, unique locks, chains + catch with derived ids, sync path,
  poison handling, failed store, `retryFailed`), `worker.ts` (loop, SIGTERM-style `stop()`,
  memory/max-jobs/max-time/stop-when-empty, restart signal, timed-out exit code 2),
  `drivers/memory.ts`, `drivers/database.ts` (CAS claim, reservation-token ack/release),
  `stores.ts` (memory + database failed-job and lock stores), `tables.ts` (`createQueueTables`
  DDL + the `queue:table` migration text), `driver-contract.ts` (runner-agnostic contract cases).
- Tests `test/queue/`: payload 37, lifecycle 31, driver contract 60 (memory + SQLite + PGlite +
  real MySQL 8.4 / MariaDB 11.4 / PostgreSQL 18 with two pools racing). *(agent-reported)*

- App wiring: `src/queue/config.ts` (`config/queue.ts` reader, `QUEUE_CONNECTION`, default `sync`
  under APP_ENV=testing else `database`, `registerQueueDriver` for add-ons, lazy database driver /
  failed store / lock store), bound in `Application#bootKernel` (a bad config stops boot).
- `Connection.afterCommit()` (runs after COMMIT once the session is released; savepoint rollback
  drops its callbacks) and `afterCommit` dispatch.
- `app/jobs` discovery (`src/queue/discover.ts`), commands `queue:table`, `queue:work`,
  `queue:restart`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:flush`, `queue:clear`
  (`src/console/commands/app/queue.ts`), `Queue` and `Bus` facades (`src/facades/queue.ts`).
- More tests: worker 11, database stores/afterCommit/two-worker exactly-once on all 5 engines,
  app + commands 9. *(agent-reported)*

## Next (in order)
1. Exports: `/queue` subpath (tsdown entry, package.json exports, smoke-dist), `queueDriverContract`
   from `/testing`, queue types from the root entry; README section; `.env.example`/skeleton note.
2. A real-process test: `node strut queue:work` gets SIGTERM mid-job and drains it.
3. Batches (`job_batches` + `job_batch_jobs`, CAS bookkeeping) and the transactional outbox +
   relay (RFC §7.1, §8).
4. Per-process worker log file once ADR-0022 logging is on main; class jobs (RFC §1.2).
5. RFC amendments: payload cap 64 KiB (portable TEXT), not 256 KiB; dispatch API is
   `Job.dispatch(data, options)` / `Job.with(data).delay().dispatch()` (no thenable);
   `maxExceptions` deferred; worker memory default 512 MB (Laravel's 128 is below a booted Node
   app); `QueueDriversToken`/`registerQueueDriver` instead of `QueueManager.extend`; the DB lock
   store reads the owner back (MySQL reports found rows, not changed rows).
6. Changeset (minor, pre `next`), full gate 3×.

## How to verify
```bash
npm ci
npx vitest run test/queue            # needs Docker for the MySQL/MariaDB/PostgreSQL cases
npm run ci                           # the full gate (lint, typecheck, coverage, build, smoke)
```

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
