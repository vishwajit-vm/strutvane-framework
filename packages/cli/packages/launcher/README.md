# strutvane

The `strutvane` command. A tiny, dependency-free launcher that always runs the `@strutvane/cli` version pinned in your project, so generators and runtime match your packages.

```bash
npx strutvane@next new acme         # create a project (runs create-strutvane@next)
cd acme && npx strutvane routes       # inside a project: delegates to node_modules/@strutvane/cli
```

Until 1.0, Strutvane is published under the npm dist-tag `next` (`latest` only holds a name placeholder), hence `strutvane@next`; from 1.0 it is `npx strutvane new acme`.

- Inside a project, project commands are handed to the local CLI with the same arguments and exit code. Local always wins over global.
- A folder is a project only when its package.json lists `@strutvane/cli` (dependencies or devDependencies) or it contains `strutvane.config.ts`. The search walks up from the working directory but never accepts a drive or file-system root, the OS temp folder or a folder above your home directory; on macOS and Linux the folder must belong to you.
- `--version`, `help`, `new` and `create` are always answered by the launcher itself, never delegated. To list a project's commands, run `pnpm exec strutvane-cli help`.
- Outside a project, only `new`, `doctor --global`, `--version` and `help` run. `npx` is started as `node npx-cli.js` without a shell when npm sits next to Node.js; on Windows the fallback resolves `npx.cmd` from PATH only, never the working directory.
- `new` runs `create-strutvane` from the launcher's own release channel: `create-strutvane@next` for a `-next` pre-release, `create-strutvane@latest` for a stable version (any other prerelease id is its own channel; anything unusual falls back to `latest`). `doctor --global` runs `@strutvane/cli` at the launcher's exact version, since both are released together.
- A version difference between launcher and local CLI is noted once on stderr (silenced by `--json`, `--quiet` or `STRUTVANE_NO_UPDATE_NOTICE=1`).

> Pre-release (`0.1.0-next.0`). Full documentation: https://github.com/vishwajit-vm/strutvane-cli#readme

MIT © 2026 The Strutvane Authors
