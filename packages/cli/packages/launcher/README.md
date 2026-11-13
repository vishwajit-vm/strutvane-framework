# strutvane

The `strutvane` command. A tiny, dependency-free launcher that always runs the `@strutvane/cli` version pinned in your project, so generators and runtime match your packages.

```bash
npx strutvane new acme         # create a project (runs create-strutvane)
cd acme && npx strutvane help  # inside a project: delegates to node_modules/@strutvane/cli
```

- Inside a project (searched from the working directory up to `strutvane.config.ts`), every command is handed to the local CLI with the same arguments and exit code. Local always wins over global.
- Outside a project, only `new`, `doctor --global`, `--version` and `help` run.
- A version difference between launcher and local CLI is noted once on stderr (silenced by `--json`, `--quiet` or `STRUTVANE_NO_UPDATE_NOTICE=1`).

> Pre-release (`0.1.0-next.0`). Full documentation: https://github.com/vishwajit-vm/strutvane-cli#readme

MIT © 2026 The Strutvane Authors
