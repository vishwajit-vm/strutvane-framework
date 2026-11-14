# Consolidation: contracts, core, devkit and cli folded into the framework

> **Status (2026-11-15):** done locally on branch `v2/consolidate` of `strutvane-framework`. Not merged into `main`, not pushed, nothing published. The owner approves the merge after review.
>
> **Why this exists:** Phase 0 of the v2 blueprint (hub `docs/18-v2-blueprint.md` §3.2 and §10). It follows the recipe that the monorepo dry run tested on scratch copies (hub `docs/research/2026-11-14-monorepo-dryrun.md` §2, §4 and §6).

## 1. What moved where

`@strutvane/framework` is now one npm package that also holds the kernel, the shared contracts, the installer/generator SDK and the CLI, the way `laravel/framework` holds Laravel's namespaces.

| Was (repo / npm package) | Source now | Tests now | Import it as |
|---|---|---|---|
| `strutvane-contracts` / `@strutvane/contracts` | `src/contracts/` | `test/contracts/` | `@strutvane/framework/contracts` |
| `strutvane-core` / `@strutvane/core` | `src/core/` | `test/core/` | `@strutvane/framework/core` |
| `strutvane-devkit` / `@strutvane/devkit` | `src/devkit/` | `test/devkit/` | `@strutvane/framework/devkit` |
| `strutvane-cli` / `@strutvane/cli` (`packages/cli`) | `src/console/` | `test/console/` | `@strutvane/framework/console` |
| `strutvane-cli` / `strutvane` launcher (`packages/launcher`) | retired, history only | not carried over (46 tests) | inside an app, the framework's `strutvane` bin. The launcher's own features, `strutvane new` / `strutvane create` and delegating to the project's CLI version, are gone (blueprint §3.2) |

- **Bins:** `strutvane` (the v2 name) and `strutvane-cli` (the name `@strutvane/cli` used). Both run `dist/console/bin.mjs`. The alias exists because generated apps' `sv` script calls `strutvane-cli`, so swapping the dependency changes nothing for them.
- **Changelogs:** `docs/changelogs/<part>.md` (plus `launcher.md`). **Old READMEs:** `docs/absorbed/<part>.md`.
- **Changesets:** the 17 pending ones are `.changeset/<part>-*.md` and now target `@strutvane/framework`, keeping the highest bump when one file named several packages. `npx changeset status` passes.
  - One empty changeset from contracts was dropped. It already made `changeset status` fail in the contracts repo, and its text shipped in `0.1.0-next.0`.
  - The absorbed `pre/` records of what `0.1.0-next.0` shipped are in `docs/changelogs/released/`. Changesets reads `.changeset/pre/` too, and refuses records for packages that are not in the repo.
- **Inside the repo,** the parts import each other by relative `.ts` path, never through the package name, so tests run straight from source.
- **Layering** (it used to be the repo boundary): `contracts` imports nothing of ours; `core` and `devkit` import only `contracts`; `console` may use `contracts`, `core` and `devkit`; the framework's own modules use `contracts` and `core`. Nothing enforces this yet (see §7).
- **Left the tree, kept in history:** each absorbed repo's synced configs, `pnpm-lock.yaml`, CI workflows, `CLAUDE.md`, `.claude/` agents and skills, issue templates, and the launcher package.

**Not moved: the logs pipeline.** The blueprint (§3.2, §10) says the logs pipeline also moves into the framework, with the viewer becoming `strutvane-log-viewer`. The dry-run recipe this work follows does not fold it: it treats `logs` as a dependent to rename. Folding it means splitting one package in two, which is more than a move. So `@strutvane/logs` stays a separate dependent here. The two hub documents disagree, and the hub should settle it (§7).

## 2. Why one package

From dry run §2.1:
- It is what `laravel/framework` is: one package, many namespaces.
- One package means one version, one staged publish and one 2FA approval per release (ADR-0018), instead of five.
- No build order inside the repo: tests import siblings from source, so nothing needs `dist/` first.
- Internal npm workspaces were rejected. They keep five published names, each with its own staging and Trusted Publisher, and bring back npm's "workspace scripts run in listed order" problem.

## 3. History

Every commit of the four absorbed repos (79) is reachable from this branch.

1. Each repo was cloned to a throw-away folder and its history rewritten so every path sits under `packages/<name>/` (`docs/consolidation/rewrite.sh`). The real repos were never touched.
2. Each rewritten history was merged with `--allow-unrelated-histories`: four `chore: import strutvane-<name> history` merge commits.
3. One commit of **pure renames** (247 renames at 100% similarity, 168 deletions, no content changes) moved the files into place. So `git log --follow` and `git blame` reach the original commits. For example, `git log --follow -- src/core/index.ts` ends at `feat: @strutvane/core 0.1.0-next.0 (kernel)`.

Rewriting changed the commit ids. `docs/consolidation/commit-map.txt` maps every original id to its new one, with the subject (checked: subjects, authors and dates match one to one). The rewrite is deterministic: replaying it gives the same ids.

Branch commits on top of `main` (`62355a1`):

| Commit | What |
|---|---|
| 4 × `chore: import strutvane-<name> history (staged under packages/<name>/)` | the merges |
| `refactor: fold contracts, core, devkit and cli into the framework tree (pure renames)` | renames only |
| `refactor: one @strutvane/framework package (imports, exports, bin, build, tests); pnpm to npm` | the codemod, the config and npm |
| `fix: keep changesets and the npm guards working in the consolidated repo` | review fixes: the changesets layout, fsevents, the npm version |
| `docs: CONSOLIDATION.md, replay scripts and docs for the consolidated framework` | this file, `docs/consolidation/`, README, CLAUDE.md, CONTRIBUTING |

## 4. What changed besides renames

All mechanical, done by `docs/consolidation/convert.mjs` and then Biome's safe fixes (import order and line wrapping), unless marked *by hand*.

- **Imports.** 112 package imports (`@strutvane/core` and so on) became relative paths. 125 relative imports and 1 `new URL('../src/bin.ts', import.meta.url)` were remapped where source and tests moved apart. Only real import specifiers were touched (found with TypeScript's `preProcessFile`). **Code inside template strings is unchanged:** generated apps and the CLI's `make:*` output still name `@strutvane/core` and `@strutvane/cli` (see B6/B7 in §7).
- **CLI version, the only real source change.** `src/console/version.ts` read `../package.json`, which from `src/console/` no longer reaches the package root, so the CLI silently said `0.0.0`. It now walks up to the nearest `package.json` (`ownManifest()`). That is right from `src/` and from any `dist/` chunk. Two new tests cover it *(by hand)*. The existing "JSON without a version" test now points at the framework root's `tsconfig.json`; it used to be the CLI repo root's.
- **`package.json`:** dependencies are the union of the five packages. There were no version conflicts. `zod` stays a runtime dependency only. The `@strutvane/{contracts,core}` dependencies are gone. New exports `./contracts`, `./core`, `./devkit` and `./console`, the two bins, and a `test:perf` script for the CLI's performance-budget suite were added. `packageManager` was dropped.
- **Build:** `tsdown.config.ts` gains `contracts/index`, `core/index`, `devkit/index`, `console/index` and `console/bin`.
- **Tests:** `vitest.config.ts` uses the CLI's 60 s timeouts (the largest any absorbed repo needed), skips the CLI's fixture app, and leaves `src/console/bin.ts` out of coverage, as the CLI repo did. `tsconfig.json` excludes `test/console/fixtures` (app data, as in the CLI repo).
- **Docs** *(by hand):* README (quick start import, install line, development section, package table), CLAUDE.md, CONTRIBUTING.md and `.changeset/README.md` now describe the consolidated package and npm.

**Where this differs from the dry run:**
- The absorbed `pre/` changesets are kept as docs in `docs/changelogs/released/`. The dry run flattened them into pending changesets, which would have listed `0.1.0-next.0`'s notes a second time. Leaving them in `.changeset/pre/` breaks Changesets.
- The absorbed READMEs are kept in `docs/absorbed/`.
- The `strutvane-cli` alias bin and the `test:perf` script were added.
- The npm supply-chain guards (B11) are added now, not in a follow-up, because `npm install` now runs in this repo for real.

## 5. Package manager: npm

The v1 repos use pnpm. The blueprint moves to npm (§7), and anything new uses npm. This branch therefore switches the framework repo to npm, as the dry run did:
- `pnpm-lock.yaml` and `pnpm-workspace.yaml` are replaced by `package-lock.json`. The lockfile carries the platform binaries for Linux, macOS and Windows.
- `.npmrc` restores the guards pnpm gave:

| pnpm (`pnpm-workspace.yaml`) | npm 11.19+ (`.npmrc` + `package.json`) |
|---|---|
| `allowBuilds: { esbuild: true }` | `strict-allow-scripts=true`, plus `allowScripts` with esbuild's three versions pinned (`npm approve-scripts esbuild`) and `fsevents@2.3.3: false`. That optional macOS dependency of vite/tsx has an install script pnpm never ran. Any other install script fails the install. |
| `minimumReleaseAge` (default 1 day), `minimumReleaseAgeExclude: ["@strutvane/*"]` | `min-release-age=1`, `min-release-age-exclude[]=@strutvane/*` |
| (none) | `allow-git=none`, `engine-strict=true` |
| `packageManager: pnpm@12.18.0` | `devEngines.packageManager`: npm `>=11.19.0`, `onFail: error`. An older npm would silently ignore the guards above. |

- **Gate:** `npm install` (or `npm ci`), then `npm run ci`. The `ci` script itself is unchanged: Biome, `tsc --noEmit`, `vitest run --coverage`, `tsdown`.
- **Caveat:** the synced CI workflow (`.github/workflows/ci.yml`) still sets up pnpm from `packageManager`, which is now gone. The canonical workflows must move to npm in `strutvane-tooling` **before this branch is pushed or merged** (§7). Synced files were not edited here.

## 6. Results

### 6.1 The framework gate

Before: each repo's own pnpm gate on a fresh clone of `main`, run on 2026-11-15 (the same numbers as the dry run). After: `npm run ci` on this branch.

| Suite | Before (own repo, pnpm) | After (`v2/consolidate`, npm) |
|---|---|---|
| framework | 349 + 1 skipped | 349 + 1 skipped |
| contracts → `test/contracts` | 40 | 40 |
| core → `test/core` | 157 | 157 |
| devkit → `test/devkit` | 370 + 13 skipped | 370 + 13 skipped |
| cli → `test/console` | 370 (the repo ran 416: cli 370 + launcher 46) | 372 (370 + 2 new version tests) |
| **Total** | **1,286 + 14 skipped** (1,332 with the launcher) | **1,288 + 14 skipped**, 83 files, type tests clean |

- Biome: clean, with 3 warnings that already existed (2 framework, 1 cli).
- `tsc` clean. Coverage 96.65 / 90.6 / 96.78 / 97.47 (thresholds 90/85/90/90).
- Build passes. The gate takes about 142 s; the five old gates took about 215 s together.
- Smoke checks: `node dist/console/bin.mjs --version` prints `strutvane 0.1.0-next.0`, the package self-reference `import('@strutvane/framework/core')` works, and `npm pack --dry-run` gives one 90-file tarball (774 kB).

### 6.2 Dependents against the local merged framework

These ran on throw-away clones in an uncommitted umbrella folder that links the clones with npm workspaces, as in dry-run step (b). **Nothing was committed to the dependent repos.** In each clone, the imports were rewritten (`@strutvane/core` → `@strutvane/framework/core`, and so on) and the absorbed dependencies became one `@strutvane/framework` dependency. create-strutvane also got the dry run's B3 test-helper fix and B7 template change.

`npm ls @strutvane/framework` shows every dependent resolving to the local `packages/framework` (a link). No old `@strutvane/{core,contracts,devkit,cli}` is installed anywhere in the tree.

| Repo | Imports rewritten | `tsc --noEmit` against the local framework | Full gate, before (own repo, pnpm) | Full gate, after (umbrella, npm) |
|---|---|---|---|---|
| logs | 15 | clean | 282 + 1 skipped | **282 + 1 skipped** (22 s) |
| auth | 53 | clean | 375 | **375** (28 s) |
| ui | 37 | clean | 269 | **269** (32 s) |
| create-strutvane | 15 | clean | 382 + 2 skipped | **381 + 3 skipped** (55 s) |

- Each gate is Biome, `tsc`, tests with coverage and build, run after Biome's safe re-wrap of the rewritten imports.
- **The one extra skip in create-strutvane is expected.** `sv calls the bin @strutvane/cli publishes` reads a sibling `../cli/packages/cli/package.json`, which no longer exists. This is the silent-skip pattern of B5. The test must be retargeted to the framework's bins (B6). The framework still publishes `strutvane-cli`, so the retargeted check will hold.
- The other two skips are the same as in the baseline:
  - the hub-spec excerpt, which only exists when the hub is the umbrella;
  - the `dist` bin test, which runs only after a previous build.

## 7. Follow-ups

**Owner actions (not done here):**
- Review this branch, then merge it into `main`. Do this only after the tooling CI change below.
- Write the ADR "Laravel-style repository layout", superseding ADR-0002 and D17/D23 as they apply to core, contracts, cli and devkit (recipe step 1). Settle the logs-pipeline question (§1).
- **Archive** `vishwajit-vm/strutvane-{contracts,core,devkit,cli}` on GitHub: read-only, never deleted, with a README pointing here. Freeze them first: any commit that lands there after 2026-11-15 must be carried over by hand.
- **npm, only after the account unlocks (2026-11-17):**
  - publish `@strutvane/framework` with the new subpaths (staged, then 2FA approval);
  - then run `npm deprecate` on `@strutvane/{contracts,core,devkit,cli}` with a pointer such as "merged into @strutvane/framework/core", and on `strutvane` unless it is kept as a shim;
  - re-point or remove their Trusted Publishers (B13). `repository.url` here already points to `strutvane-framework`.

**strutvane-tooling** (synced files were not edited here):
- Switch `canonical/.github/workflows/{ci,release}.yml` to npm (dry run §5.2): `npm install -g npm@11.19.0`, `npm ci`, `npm audit signatures`, `npm run ci`. This **blocks** merging this branch.
- Anchor `.gitignore`'s `logs/` as `/logs/` (B1).
- Drop the `contracts`, `core`, `devkit` and `cli` targets from `manifest.json`. Retire `workspace-packages.mjs`.
- Update the synced `strutvane-contribute` skill and `ECOSYSTEM.md`, which still say `corepack pnpm@12.18.0`.

**This repo, one reviewed PR each (they change behaviour, so they are not in this branch):**
- **B6 (do it before the first publish of this layout):** the CLI still calls itself `@strutvane/cli`. Its version is now the framework's, so `sv about` and generated headers show `@strutvane/cli <framework version>`, and the doctor hint tells apps to `pnpm add -D @strutvane/cli`, which would bring back a second kernel. Places that still say `@strutvane/cli` or describe the launcher: `CLI_PACKAGE`, the generator header, `about`, the doctor check and hint, project detection in `boundary.ts` and the help text. An app that depends only on `@strutvane/framework` and has no `strutvane.config.ts` is not detected as a project. There are also TSDoc lines that still mention the launcher. Make the framework the CLI's identity and accept it (or `strut.js`) in detection. Decide whether `@strutvane/cli`'s `./bin` export needs a `./console/bin` successor (nothing in the dependents uses it).
- **B10:** the package-migration gate refuses migrations whose realpath leaves `node_modules`. That includes npm workspace links (junctions on Windows), so it also refuses them in a workspace app or the umbrella. Allow realpaths inside the declared workspace root.
- Add a module-boundary lint rule for the layering in §1.
- Before the first release, run `npx changeset status` and check that the merged changesets read well as one framework changelog (B16). Two of them, `cli-launcher-project-detection.md` and `cli-launcher-release-channel.md`, now target the framework but describe the retired launcher: drop them or reword them.
- Port what is still useful from the absorbed repos' `.claude/` agents and skills (contract-compat-reviewer, api-surface-reviewer, installer-safety-reviewer, cli-ux-reviewer, add-command and others). They are in history.

**Dependents** (recipe step 8, one PR each, after the framework is published):
- Run the import codemod.
- Make `@strutvane/framework` a **peer + dev** dependency (B9).
- Convert to npm.
- create-strutvane also needs B3, B7 and the B8 decision: does the installer depend on the framework or not?

**Hub:** an umbrella `package.json` writer and `verify-links` in `scripts/setup-workspace.mjs`, and `scripts/e2e-local.mjs` rewritten for npm.

## 8. Open risks

- **CI is red until tooling moves to npm.** The synced workflow needs pnpm's `packageManager` field (§5).
- **Two copies of the kernel during the transition.** A dependent still on the published `@strutvane/core` gets a second kernel next to `@strutvane/framework/core`. Container tokens and `instanceof` checks then break across them. Retarget dependents together with the framework release, and peer-depend (B9).
- **Freeze window.** Commits that land in the old repos after this branch was cut are not included. The old repos were clean on `main` when it was cut; their tips are in `commit-map.txt`.
- **`strutvane-cli` is declared by two packages during the upgrade.** An app that depends on both `@strutvane/framework` and the old `@strutvane/cli` gets two packages declaring the same bin, and which one `sv` runs depends on npm's linking. The upgrade guide must say "remove `@strutvane/cli`", and doctor should flag a project that has both (B6).
- **Generated apps still name `@strutvane/core` and `@strutvane/cli`** (template strings, by design). They keep working only while those packages stay installable. Deprecated is fine; unpublished is not.
- **`npm audit`:** 4 moderate findings, all `esbuild <= 0.24.2` through `drizzle-kit → @esbuild-kit/*` (GHSA-67mh-4wv8-2f99, dev server only). They existed under pnpm too (B15).
- **History tool.** `git filter-repo` was not installed, and installing it needs the owner's approval. `git filter-branch` was used instead. It is slower, but the result is the same and deterministic.

## 9. How to replay

The scripts are in `docs/consolidation/`. They need git and Bash (Git Bash on Windows), Node 24 and npm 11.19+.

```bash
# 0. Freeze the four repos. Folder layout as in the hub: packages/<name>/ (setup-workspace.mjs).
P=/path/to/strutvane/packages; S=/path/to/scratch
# 1. Rewrite the four histories on throw-away clones (filter-branch; or filter-repo, same result).
bash docs/consolidation/rewrite.sh "$P" "$S"
# 2. Merge them into a new branch of the framework repo (a separate worktree) + the rename commit.
bash docs/consolidation/merge.sh "$P/framework" "$S" "$S/fw"
# 3. Codemod and config (needs a node_modules with typescript, e.g. any v1 repo after install).
node docs/consolidation/convert.mjs "$S/fw" "$P/contracts" "$P"
cd "$S/fw" && npx biome check --write .
# 4. npm: the .npmrc from this branch, then install without scripts, approve esbuild, rebuild.
git show v2/consolidate:.npmrc > .npmrc
npm install --ignore-scripts && npm approve-scripts esbuild && npm rebuild esbuild
npx changeset status
# 5. The two version tests and the docs are hand edits: take them from this branch's last two commits.
npm run ci
```

The replay was checked on 2026-11-15 from fresh clones. The rewritten histories came out byte-identical. The rename commit's tree was identical. After step 4, the tree differed from this branch only in the hand-written parts: the docs, `.npmrc`, the lockfile, esbuild's `allowScripts` entries and the two version tests.
