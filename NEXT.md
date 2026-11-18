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
