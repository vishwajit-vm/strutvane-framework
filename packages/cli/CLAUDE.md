# CLAUDE.md: Strutvane CLI (`@strutvane/cli + strutvane`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

The unified Strutvane command line (`strutvane`, `pnpm sv`): create projects, add packages, make models and resources, run migrations, list routes and permissions, eject code and upgrade safely.

It is one repo of the **Strutvane** polyrepo ecosystem (one GitHub repo per package; see ADR-0002). The hub with the full blueprint is https://github.com/vishwajit-vm/strutvane. Locally it is the umbrella folder two levels up: `../../docs/`.

## Status

- **Phase 1: implemented, tested, not released.** Both packages are at `0.1.0-next.0` (Changesets pre mode `next`, released together via `fixed`). `corepack pnpm@12.18.0 run ci` is green; coverage is above 90/90/85/90.
- Layout: a private pnpm workspace. `packages/cli` = `@strutvane/cli` (bin `strutvane-cli`), `packages/launcher` = `strutvane` (bin `strutvane`, zero dependencies). Root scripts lint, typecheck, test and build both.
- Code map (`packages/cli/src`): `framework/` (runner, router, parsing, output, errors, exit codes, prompts, services), `commands/` (one file per command group), `make/` (field mini-language, names, templates, devkit generators), `project/` (project facts, env files, contributions, semver), `registry/` (the ADR-0010 compiler ported from spike 04), `main.ts`/`bin.ts` (process entry).
- **TEMPORARY:** `pnpm-workspace.yaml` overrides link `../contracts`, `../core`, `../devkit` until `0.1.0-next.0` of those is on npm (ADR-0016). Never commit them; CI's check-deps guard fails while they exist.
- Commands: `corepack pnpm@12.18.0 run ci` (must pass before any commit).
- Synced files (`tsconfig.base.json`, `biome.base.json`, `vitest.shared.ts`, `.github/workflows/*`, `.github/scripts/*`, `.gitattributes`, `.gitignore`, `.editorconfig`) come from strutvane-tooling. Never edit them here.
- The source of truth for decisions is `../../docs/00-executive-summary.md` (D1–D24). If anything here conflicts with it, that file wins.
- The package spec is `../../docs/09-cli-reference.md` (online: https://github.com/vishwajit-vm/strutvane/blob/main/docs/09-cli-reference.md).

## Working rules for this repo

- Commands never print errors or exit: they throw `CliError` (code from `framework/messages.ts`, exit code from `framework/exit-codes.ts`) and return `{ data }`. The runner renders text or the `--json` envelope.
- Output goes through `ctx.out`, never `console`/`process.stdout`; side effects (spawn, clock, env, TTY) go through `ctx.services`, so every command is testable in-process.
- Never prompt when not interactive (no TTY, `--yes`, `--no-interactive`, `--json`).
- Contributed code (`strutvane.commands|installer|templates`) is only imported from inside the package's own folder in `node_modules`; keep that check when touching `project/contributions.ts`.
- Generated files must keep the static shape the registry compiler reads; add a golden test (`test/__golden__`) for any template change.

## Boundaries (non-negotiable)

- Allowed dependencies: `@strutvane/contracts` (types), `@strutvane/core` and `@strutvane/devkit`, plus pinned third-party libraries: `oxc-parser` (registry analysis, ADR-0010), `@clack/prompts` (interactive prompts) and `zod` (generator inputs). The launcher has no dependencies at all. Package installers and commands are loaded from the user project at runtime, so the CLI never hard-depends on framework, auth or ui.
- Cooperation with other Strutvane packages happens **only through `@strutvane/contracts`**, resolved at runtime via the core container.
- Public API changes need a changeset, docs and tests. Contract changes need an RFC.

## Conventions

- TypeScript strict, ESM only, Node 24+ (Node 26 LTS is the target). No decorators or reflection.
- Validation uses Standard Schema with Zod 4 as the default. Errors are RFC 9457 problem+json.
- Tooling: pnpm, tsdown (build), Biome (lint/format), Vitest (tests), Playwright (UI e2e), Testcontainers (DB).
- AST work for the registry uses `oxc-parser` (ADR-0010 supersedes the earlier TypeScript-compiler-API plan for static analysis).
- Releases: Changesets, npm trusted publishing (OIDC) with provenance. Core packages share a major release train.
- **Docker is local-only and never committed** (ADR-0006). Never commit `.env`; keep `.env.example` complete and documented.
- Windows, macOS and Linux are all first-class. Use no bash-only scripts.

## Definition of done (for any change)

Code, tests, docs and a changeset ship together. Security implications are noted. The CLI help or reference is updated if commands changed.

## Where things are

- `.claude/skills/`: task playbooks for this package (invoke by name)
- `.claude/agents/`: specialised reviewer subagents
- `.claude/commands/`: slash commands (`/spec`, `/pre-pr`)
