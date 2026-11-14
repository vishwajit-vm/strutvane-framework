# CLAUDE.md: Strutvane Core (`@strutvane/core`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

The Strutvane kernel: application lifecycle, typed service container, service providers, validated config and env, request context, hooks, events, logging, errors and the plugin host.

It is one repo of the **Strutvane** polyrepo ecosystem (one GitHub repo per package; see ADR-0002). The hub with the full blueprint is https://github.com/vishwajit-vm/strutvane. Locally it is the umbrella folder two levels up: `../../docs/`.

## Status

- **Implemented: `0.1.0-next.0` (Phase 1), not yet released to npm.** All modules are in `src/`, one concept per file:
  - `container.ts`, `application.ts`, `tokens.ts`
  - `config.ts`, `env.ts`, `context.ts`
  - `hooks.ts`, `events.ts`
  - `errors/` (classes, registry, `toProblem`)
  - `messages/` (formatter, locales, catalogs, built-in English)
  - `logger/` (default logger, safe serialisation)
  - `clock.ts`, `uuid.ts`
- Tests are in `test/`: runtime, fast-check property, type-level (`*.test-d.ts`) and README-example tests. `test/readme.test.ts` runs the README examples, so update both together.
- Gate: `corepack pnpm@12.18.0 run ci` (lint → typecheck → tests + coverage 90/90/85/90 → build).
- **Temporary:** `pnpm-workspace.yaml` overrides `@strutvane/contracts` with `link:../contracts` until contracts is published. **Never commit it**; the CI `check-deps` guard rejects it. Remove it once `@strutvane/contracts@0.1.0-next.0` is on npm.
- Changesets is in pre mode (`next` tag, `.changeset/pre.json`).
- Design first: read this package's spec and the ADRs, and write or extend an RFC before changing any public API.
- The source of truth for decisions is `../../docs/00-executive-summary.md` (D1–D20). If anything here conflicts with it, that file wins.
- The package spec is `../../docs/04-architecture.md` (online: https://github.com/vishwajit-vm/strutvane/blob/main/docs/04-architecture.md).

## Boundaries (non-negotiable)

- Allowed dependencies: `@strutvane/contracts` only. Core must stay small, fast to import and free of database, HTTP-engine and UI dependencies.
- Cooperation with other Strutvane packages happens **only through `@strutvane/contracts`**, resolved at runtime via the core container.
- Public API changes need a changeset, docs and tests. Contract changes need an RFC.

## Conventions

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
