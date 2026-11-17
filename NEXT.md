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
