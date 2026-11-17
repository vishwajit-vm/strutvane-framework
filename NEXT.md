# v2/app-core: where the port stands

Working notes for the spike 12 port (MVC app core + Laravel-style commands). Delete before merge.

## State (2026-11-17, agent session; numbers are *(agent-reported)* until the coordinator re-runs them)
Every item of the paused plan is done; the branch is ready for the coordinator's verification
and the merge with `v2/data-layer`.

- Gate (`npm run ci`: lint, typecheck, tests + coverage 90/90/85/90, build), 3 runs in a row while
  a CPU burner kept 8 of 16 cores busy: 
  - run 1: tests all passed, but exit 1: 5 test files never started (vitest "Timeout waiting for
    worker to respond", 60 s worker start under the overload; cold transform cache). No test failed.
  - runs 2, 3, 4 (in a row): exit 0, 1,987 passed, 14 skipped (2,001), 0 type errors; coverage
    97.03 / 91.8 / 97.04 / 97.87 (statements / branches / functions / lines). Build OK.
  - If the "under load" gate must survive heavier load than this, cap `maxWorkers` in
    vitest.config.ts (not done: data-layer also edits that file).
- R1/R5 (agent-run): `check-code-rules.mjs` OK, `check-deps.mjs` OK, `check-package.mjs` OK (162 files),
  publint 0.3.25 `--strict` All good, attw 0.18.5 `--profile esm-only` exit 0 (node16-ESM and bundler green on every subpath, incl. `./facades`),
  `npm audit --omit=dev --audit-level=high` exit 0 (4 moderate, all through drizzle-kit's esbuild).

## Done (commits on this branch since ef3ab03)
1. tsc fixture in `test/commands/caches.test.ts` (the helpers' `web` option takes any routes source).
2. Command tests: `test/commands/{maintenance,keys,cache-store,security,make,cli}.test.ts`
   (down/up with every option, 9 hostile `--redirect` values, `--render` checks, corrupt state,
   another Node process reading the state; key rotation keeps old ciphertexts and signed links;
   env crypt round trip, wrong key, flipped byte, 4/8/12-byte tags; file cache with 4 processes
   incrementing one key, lock takeover/timeout; `security:check` incl. `--audit` via a fake
   spawner; `route:list --security`; `make:*` outputs type-checked with tsc).
3. Lowercase error codes (#123) across src/test/README with `core/errors/legacy-codes.ts`
   (`LEGACY_ERROR_CODES`, `currentErrorCode`; StrutvaneError and the registry map old names with a
   one-time `DeprecationWarning`, code `STRUTVANE_UPPERCASE_ERROR_CODE`); issue `field` member (#69).
   Type tests: `test/core/error-codes.test-d.ts`, `test/contracts/v01-types.test-d.ts`.
4. `src/messages.ts` owns the application catalogs (`APPLICATION_ERRORS`, `APPLICATION_MESSAGES_EN`,
   `registerApplicationErrors`, `applicationMessages`); `src/index.ts` exports the app core;
   `./facades` subpath (package.json + tsdown); `route` = `routing/route-helper.ts` (index and /http).
5. `serve.ts` passes `{ ip, waitUntil }` (close waits for waitUntil work); `startApplication()` /
   `startProject()` boot `bootstrap/app.ts` for `node strut start`/`dev`; `resolveTrustProxy` in
   `serve.ts` and `createHttpApp` (list form works, `'*'` refused at boot); HSTS production-only.
6. CLI: app roots are projects (`APP_MARKERS`, `isAppRoot` in `console/project/project.ts`; no
   package.json needed), app `withCommands()` merged into the CLI, `list` with `help` as alias,
   BootError mapped in `toFailure`, `sv` → `node strut` in CLI text, help, templates and goldens.
7. `serve-lifecycle.test.ts` "outlives the grace period": injected grace timer
   (`ServeOptions.timer`), now also proves the request is alive until the deadline.
8. Changeset `.changeset/v2-app-core.md` (minor, #128); README "The application core (v2)" and
   "Upgrading to 0.2: lowercase error codes".

## For the merge with v2/data-layer (coordinator)
- Expected conflicts: `src/commands.ts` (start uses `startProject`/`startedEnv`), `package.json`
  (`./facades` export), `tsdown.config.ts` (`facades/index` entry), `src/index.ts`, NEXT.md.
- data-layer adds `'INVALID_ARGUMENT'` in its make.ts diff: rename it to `invalid_argument`.
- Still saying `sv` (left alone to avoid conflicts; data-layer owns them): `src/commands.ts`,
  `src/console/commands/make.ts`, `src/runtime/seeders.ts`, `src/runtime/migrations.ts`,
  `src/migrations/*`. Run `grep -rnE "(^|[\` '\"(])sv [a-z]" src` after the merge.
- Re-run the codemod check after merging: `grep -rnE "['\"][A-Z]+(_[A-Z0-9]+)+['\"]" src` should
  list only env variable names and the legacy table.

## Decisions for the lead
- Error codes: the compat window maps old names in `StrutvaneError` and the registry, and
  `LEGACY_ERROR_CODES` covers HTTP, CLI, devkit, container and DSL codes. Message-catalog keys are
  NOT mapped (`errors.NOT_FOUND.title` overrides stop applying); the framework is unreleased, so
  no app should have them. auth/ui (main) still compare uppercase codes (e.g. `'VALIDATION_FAILED'`
  44× in auth, `'NOT_FOUND'` in ui): their v2 branches must switch before the 0.2 train.
- `ValidationIssue.field` is required in the contract type (an add-on that builds issues by hand
  must add it); RFC-0003 in the hub needs the matching update (`field`, lowercase codes).
- HSTS is production-only in `createHttpApp` too (was: any HTTPS request).
- An app's own commands (`withCommands`) are read without booting; commands a provider adds in
  `register()` are not in the CLI yet (would need a boot per CLI call).
- `node strut start` on an app does not pass `trustProxy`/`publicUrl` to the adapter: the app
  applies its own `trustProxies()` from `withMiddleware` to the socket peer.
- Earlier, still open: generated apps must not set `isolatedDeclarations`; `route:list` (apps) and
  `routes` (strutvane.config.ts projects) both stay; an unsafe request with a session cookie to an
  unknown path answers 419 (CSRF runs before routing).

## How to verify
```bash
npm ci
npm run ci                                  # 3x; also under load
node .github/scripts/check-code-rules.mjs && node .github/scripts/check-deps.mjs
npm pack --pack-destination ../pack && node .github/scripts/check-package.mjs
npm exec --yes --package=publint@0.3.25 -- publint run ../pack/*.tgz --strict
npm exec --yes --package=@arethetypeswrong/cli@0.18.5 -- attw ../pack/*.tgz --profile esm-only
npm audit --omit=dev --audit-level=high
```
