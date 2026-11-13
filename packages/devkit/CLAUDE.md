# CLAUDE.md: Strutvane Devkit (`@strutvane/devkit`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

SDK for building Strutvane installers, generators, plugins and codemods: staged transactional file writes, env-file editing, config AST patching, templates, three-way merge and dry-run diffs.

It is one repo of the **Strutvane** polyrepo ecosystem (one GitHub repo per package; see ADR-0002). The hub with the full blueprint is https://github.com/vishwajit-vm/strutvane. Locally it is the umbrella folder two levels up: `../../docs/`.

## Status

- **Phase 1: implemented, version `0.1.0-next.0`, not released.** Changesets is in pre mode (`next`).
- `@strutvane/contracts` is not published yet, so `pnpm-workspace.yaml` has a **temporary** `link:../contracts` override. Remove it once contracts `0.1.0-next.0` is on npm (ADR-0016; `check-deps` flags it until then).
- The source of truth for decisions is `../../docs/00-executive-summary.md` (D1–D24). If anything here conflicts with it, that file wins.
- The package spec is `../../docs/04-architecture.md` (online: https://github.com/vishwajit-vm/strutvane/blob/main/docs/04-architecture.md). The merge engine follows ADR-0012 (spike 06).

## Code map (`src/`, one concept per file)

| File | Role |
|---|---|
| `paths.ts` | Project-relative path validation, symlink/junction escape checks and protected locations (`.git`, `node_modules`, `.strutvane/staging`; recovery also refuses `.strutvane/**` except lock + bases). Every disk access goes through it. |
| `io.ts` | `DevkitIo`, the injectable file-system surface (tests inject failures). `removeFile` never recurses or follows links; `inspect` is an lstat. |
| `transaction.ts` | Stage → journal → rename commit → rollback; `planRecovery`/`recoverTransactions` after a crash. Journal paths are project-relative; recovery validates every journal first. Modes preserved; staging is 0600/0700. |
| `staged-fs.ts` | `StagedFs`: buffered writes, no-op on identical content, `FILE_EXISTS` guard, CRLF preservation, diffs. |
| `secret-files.ts` | Which env files hold secrets, and redacting them in every diff (`revealSecrets: true` opts out). |
| `env-editor.ts` / `deps-editor.ts` / `config-patcher.ts` | The installer editors. Each keeps the contract signature (`add`) and adds `ensure` (reporting) and removal. |
| `installer.ts` / `generator.ts` | Runtimes for `sv add` and `sv make:*`. |
| `text.ts` | Line-ending/BOM/final-newline shapes shared by editors and the merge. |
| `merge/` | `merge.ts` (three-way + two-way), `header.ts`, `lock.ts` (zod-validated lock + sha256 bases), `format.ts` (Biome CLI), `upgrade.ts` (plan/preview/apply/recordEjection). |

## Key behaviours to keep (tests enforce them)

- A user-only line is never lost by a merge (golden corpus `test/merge/__golden__` + fast-check properties).
- `.env.example` never gets a secret value, even for unflagged secret-looking keys or URLs with credentials.
- Diffs never show `.env`/`.env.*` values unless the caller passes `revealSecrets: true` (canary tests).
- Recovery never trusts a journal: protected paths, foreign owners, non-file targets and linked staging folders are refused before anything changes.
- The config patcher splices text at AST offsets. It never re-prints the file, and register → unregister is byte-exact.
- Contracts' `InstallFs` has no delete. Devkit extends it (`StagedFs.remove` etc.); propose adding `remove` to contracts via an RFC rather than diverging further.

## Commands

- `corepack pnpm@12.18.0 run ci`: lint → typecheck → tests + coverage (90/90/85/90) → build
- `PROPERTY_RUNS=2000 corepack pnpm@12.18.0 exec vitest run test/merge/property.test.ts`: deeper property run

## Boundaries (non-negotiable)

- Allowed dependencies: `@strutvane/core` and `@strutvane/contracts`, plus codegen libraries (magicast, ts-morph pinned to the TypeScript 6 API, diff3).
- Cooperation with other Strutvane packages happens **only through `@strutvane/contracts`**, resolved at runtime via the core container.
- Public API changes need a changeset, docs and tests. Contract changes need an RFC.

## Conventions (apply once code exists)

- TypeScript strict, ESM only, Node 24+ (Node 26 LTS is the target). No decorators or reflection.
- Validation uses Standard Schema with Zod 4 as the default. Errors are RFC 9457 problem+json.
- Tooling: pnpm, tsdown (build), Biome (lint/format), Vitest (tests), Playwright (UI e2e), Testcontainers (DB).
- Code generation and AST work pin the TypeScript 6 compiler API (`@typescript/typescript6`), because TypeScript 7 has no compiler API.
- Releases: Changesets, npm trusted publishing (OIDC) with provenance. Core packages share a major release train.
- **Docker is local-only and never committed** (ADR-0006). Never commit `.env`; keep `.env.example` complete and documented.
- Windows, macOS and Linux are all first-class. Use no bash-only scripts.

## Definition of done (for any change)

Code, tests, docs and a changeset ship together. Security implications are noted. The CLI help or reference is updated if commands changed.

## Where things are

- `.claude/skills/`: task playbooks for this package (invoke by name)
- `.claude/agents/`: specialised reviewer subagents
- `.claude/commands/`: slash commands (`/spec`, `/pre-pr`)
