<div align="center">

# Strutvane Devkit

**SDK for building Strutvane installers, generators and upgrades: staged transactional file writes, `.env` editing, config patching, typed generators and a three-way merge that never loses your edits.**

[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Implemented, not yet released.** Version `0.1.0-next.0` is built and tested (Phase 1) but not on npm yet. The API may still change before `0.1.0`.

## What it is

Strutvane Devkit is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for building enterprise B2B applications. It is the engine behind three CLI commands:

| Command | Devkit API | What it guarantees |
|---|---|---|
| `sv add <package>` / `sv remove` | `defineInstaller`, `runInstaller` | All-or-nothing, previewable, idempotent, reversible |
| `sv make:*` | `defineGenerator`, `runGenerator` | Typed, validated inputs; no template engine, no `eval` |
| `sv upgrade` | `planUpgrade`, `applyUpgrade` | A user's edit to an ejected file is never silently lost |

## Installers

An installer sets a package up in a project: config files, `.env` + `.env.example`, `package.json` and `strutvane.config.ts`. Every editor writes to **one staged file system**. Nothing touches the disk until the installer finishes, and then all changes are committed together (or rolled back together).

```ts
import { defineInstaller } from '@strutvane/devkit'

export default defineInstaller({
  name: 'notify',
  async install({ fs, env, deps, config, has, log }) {
    await fs.write('config/notify.ts', "export default { channel: 'mail' }\n")
    await env.add('Notifications', [
      { key: 'NOTIFY_DEFAULT_CHANNEL', value: 'mail' },
      { key: 'NOTIFY_SIGNING_SECRET', secret: true, comment: 'Signs webhook payloads' },
    ])
    await deps.add({ '@strutvane/notify': '0.1.0' })
    await config.registerProvider('@strutvane/notify/provider')
    if (!has('@strutvane/ui')) log.info('install @strutvane/ui for the notification centre')
  },
  async uninstall({ fs, env, deps, config }) {
    await fs.remove('config/notify.ts')
    await env.remove(['NOTIFY_DEFAULT_CHANNEL', 'NOTIFY_SIGNING_SECRET'])
    await deps.remove(['@strutvane/notify'])
    await config.unregisterProvider('@strutvane/notify/provider')
  },
})
```

```ts
import { checkIdempotent, runInstaller } from '@strutvane/devkit'

const preview = await runInstaller(installer, { projectRoot, dryRun: true })
console.log(preview.diff) // unified diff, .env values redacted; nothing written

await runInstaller(installer, { projectRoot })              // commit
await runInstaller(installer, { projectRoot, mode: 'uninstall' })
await checkIdempotent(installer, { projectRoot })           // [] when a second run changes nothing
```

What the editors promise:

- **`fs`**: writes never replace a different existing file unless you pass `{ overwrite: true }`. Writing identical content is a no-op. CRLF files stay CRLF.
- **`env`**: existing keys are never overwritten. `secret: true` generates a 256-bit random value for `.env` only. **`.env.example` never receives a secret**: secret keys, any key whose name looks secret (`*_PASSWORD`, `*_PASS`, `*_PWD`, `*_TOKEN`, `*_KEY`, `*_DSN`, `*SALT*`, `*SIGNING*`, `*ACCESS_KEY*`, …) and any value that embeds credentials in a URL (`postgres://user:password@host`) get an empty value there.
- **`deps`**: never replaces or moves a dependency the project already has, and refuses `link:`, `file:`, `workspace:` and path specs (ADR-0016).
- **`config`**: edits only the `providers` array and one import line in `strutvane.config.ts`. Comments and formatting elsewhere are untouched, and unrecognised config shapes are refused rather than guessed at.

**Previews never print secrets.** Diffs from `runInstaller`, `runGenerator`, `StagedFs.diff()` and `renderUpgradePreview` show every line of a `.env` or `.env.*` file (except `.env.example`) as `KEY=<redacted>`: added, removed and context lines alike. Comments and section headers stay visible. `fs.diff({ revealSecrets: true })` is the explicit opt-out, for output that never leaves your own terminal. `FileChange.before`/`after` hold the raw contents, so print the diff, not those fields.

Installers receive a `DevkitInstallContext`, a superset of the contracts' `InstallContext`. An installer written against `@strutvane/contracts` alone works unchanged.

## Generators

```ts
import { defineGenerator, runGenerator } from '@strutvane/devkit'
import { z } from 'zod'

const model = defineGenerator({
  name: 'model',
  inputs: z.object({ name: z.string().regex(/^[A-Z]\w*$/), fields: z.array(z.string()).default([]) }),
  files: ({ name, fields }) => [
    { path: `app/models/${name.toLowerCase()}.model.ts`, content: renderModel(name, fields) },
  ],
})

await runGenerator(model, { name: 'Invoice' }, { projectRoot, dryRun: true })
```

Inputs are any [Standard Schema](https://standardschema.dev) validator (Zod by default). Invalid input throws a `GeneratorInputError` listing every issue with its path. Templates are plain TypeScript functions, so there is no template syntax that can execute code.

## Upgrades (three-way merge)

When a user ejects a generated file, devkit records it with `recordEjection`: the file, a pristine copy (the *merge base*, in `.strutvane/base/`) and a lock entry (`.strutvane/lock.json`, with a SHA-256 of the base). On upgrade:

```ts
import { applyUpgrade, planUpgrade, renderUpgradePreview } from '@strutvane/devkit'

const plan = await planUpgrade({ projectRoot, templates: newTemplateOutputs })
console.log(renderUpgradePreview(plan)) // per-file action + unified diffs
const { written, conflicted } = await applyUpgrade({ projectRoot, plan })
```

Each file gets one action: `unchanged`, `update` (clean merge), `conflict` (standard diff3 markers plus a structured report), `create`, `skip-user-deleted` (never recreated) or `blocked` (unresolved markers, an ambiguous move, or a file someone else owns). Files the user moved are found by their template header. A missing or tampered base falls back to a two-way merge in which every difference is a conflict. A corrupt lock is backed up, never trusted. After applying, run the project's typecheck and tests: a line merge cannot see semantic conflicts (ADR-0012).

## Transactions and recovery

Every write path above uses the same engine (`commitTransaction`): stage new contents and backups in `.strutvane/staging/`, write a journal, rename into place, and roll back on failure. If the process dies mid-commit, the journal survives. New transactions then refuse to start until `recoverTransactions({ io, projectRoot })` restores the previous state.

```ts
import { planRecovery, recoverTransactions } from '@strutvane/devkit'

const plan = await planRecovery({ io, projectRoot }) // changes nothing
console.log(plan.paths)                               // every file recovery would restore or delete
await recoverTransactions({ io, projectRoot, confirmed: plan }) // refuses if the journals changed since
```

Recovery treats a journal as untrusted input. Before changing anything it validates every journal, and it refuses:

- journals owned by another user (POSIX),
- paths outside the project or in a protected location (see Safety), and anything under `.strutvane/` other than the upgrade lock and merge bases,
- backups that are not regular files,
- targets that are directories or special files.

It only replaces or unlinks single regular files: it never deletes recursively and never writes through a symlink. Permissions are preserved: a replaced file keeps its mode (a `0600` `.env` stays `0600`), new `.env`/`.env.*` files are created `0600`, backups and journals are `0600`, and staging folders are `0700`. `.strutvane` and `.strutvane/staging` must be real folders; a symlink or junction there is refused. On Windows, permission bits are best-effort and never cause a failure.

## Safety

- Every path is project-relative and checked: no `..`, no absolute or drive paths, no backslashes or control characters, and no escape through a symlink or junction.
- Protected locations are never read or written: `.git/`, `node_modules/` and devkit's transaction area `.strutvane/staging/`, at any depth. The rest of `.strutvane/` (lock, merge bases, generated registry, README) stays writable. The check covers letter case, Windows aliases (`.git.`, `.git::$DATA`, 8.3 short names) and links that resolve into those folders. Violations throw `INVALID_PATH`.
- Secrets are generated with `node:crypto`, never written to `.env.example`, and redacted from every diff.
- Module specifiers written into `strutvane.config.ts` are validated strictly (no quotes, URLs or `..` segments), so an installer cannot inject code.
- Every failure has a stable `DevkitError.code` (for example `FILE_EXISTS`, `PATH_OUTSIDE_PROJECT`, `LOCAL_DEPENDENCY_SPEC`, `TRANSACTION_ABORTED`).

## Installation (once released)

```bash
npm i -D @strutvane/devkit
```

Requires Node 24+. ESM only.

## Development

```bash
corepack pnpm@12.18.0 install
corepack pnpm@12.18.0 run ci   # lint → typecheck → tests + coverage → build
```

The test suite includes the golden merge corpus and property-based tests from Phase 0 spike 06 (`PROPERTY_RUNS` sets the number of runs, default 400), fault-injected rollback and crash-recovery tests, and a real-Biome formatter test.

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| [`@strutvane/core`](https://github.com/vishwajit-vm/strutvane-core) | Kernel: container, providers, config, context |
| [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts) | Shared types and wire protocols |
| [`strutvane` / `@strutvane/cli`](https://github.com/vishwajit-vm/strutvane-cli) | Unified CLI |
| [`@strutvane/devkit`](https://github.com/vishwajit-vm/strutvane-devkit) | SDK for installers, generators and plugins |
| [`@strutvane/logs`](https://github.com/vishwajit-vm/strutvane-logs) | Zero-config logging + built-in log viewer (default) |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter |

## Documentation

- **Package specification:** [04-architecture.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/04-architecture.md)
- **Three-way merge decision:** [ADR-0012](https://github.com/vishwajit-vm/strutvane/tree/main/docs/adr)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) and the [developer experience](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
