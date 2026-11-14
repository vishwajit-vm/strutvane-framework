# @strutvane/cli

The Strutvane command line: diagnostics (`doctor`, `env:check`), generators (`make:*`), the typed registry compiler (`registry:build`), routes/models/permissions listings, package installers (`add`/`remove`) and safe upgrades (`upgrade`).

Add it to a project as a dev dependency and run it through the `strutvane` launcher or a `sv` script:

```bash
pnpm add -D @strutvane/cli
pnpm exec strutvane-cli help    # list every command (the launcher answers `help` itself)
pnpm sv make:model Invoice
```

A folder counts as a project when its package.json lists `@strutvane/cli` or it has `strutvane.config.ts` (never a drive root, the temp folder or a folder above home). Destructive commands need `--force --i-understand` unless `APP_ENV` is local, test, testing or development; see the repository README.

As a library it exports `defineCommand` (for package and plugin commands), `runCli`, the field mini-language parser, the generators and the registry compiler.

> Pre-release (`0.1.0-next.0`). Full documentation: https://github.com/vishwajit-vm/strutvane-cli#readme

MIT © 2026 The Strutvane Authors
