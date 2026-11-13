# CLAUDE.md: Strutvane CLI (`@strutvane/cli + strutvane`)

Project memory for Claude Code in this repository. Keep this file short, accurate and current.

## What this repo is

The unified Strutvane command line (`strutvane`, `pnpm sv`): create projects, add packages, make models and resources, run migrations, list routes and permissions, eject code and upgrade safely.

It is one repo of the **Strutvane** polyrepo ecosystem (one GitHub repo per package; see ADR-0002). The hub with the full blueprint is https://github.com/vishwajit-vm/strutvane. Locally it is the umbrella folder two levels up: `../../docs/`.

## Status

- **Phase: design / pre-implementation.** There is no source code yet. Do not start implementing unless the user explicitly asks.
- The source of truth for decisions is `../../docs/00-executive-summary.md` (D1–D20). If anything here conflicts with it, that file wins.
- The package spec is `../../docs/09-cli-reference.md` (online: https://github.com/vishwajit-vm/strutvane/blob/main/docs/09-cli-reference.md).

## Boundaries (non-negotiable)

- Allowed dependencies: `@strutvane/core` and `@strutvane/devkit`. Package installers and commands are loaded from the user project at runtime, so the CLI never hard-depends on framework, auth or ui.
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
