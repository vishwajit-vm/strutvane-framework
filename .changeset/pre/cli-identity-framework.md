---
"@strutvane/framework": minor
---

The CLI now identifies as `@strutvane/framework` (B6): `sv about`, `sv help` sources, generated headers and project detection (a package.json that lists `@strutvane/framework` is a project; `@strutvane/cli` still counts for older apps). `sv doctor` checks that the framework is a dependency, gives the install command for the project's own package manager, and fails when `@strutvane/core`, `contracts`, `devkit`, `cli` or the `strutvane` launcher is declared or installed next to it (two kernels, duplicate bins), with the command that removes them. Node.js 24.3 or newer is required (`engines` and `sv doctor`).
