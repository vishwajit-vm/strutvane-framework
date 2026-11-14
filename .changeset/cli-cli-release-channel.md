---
"@strutvane/cli": patch
---

`sv add <package>` installs Strutvane packages from the CLI's own release channel (`@strutvane/auth@next` while the CLI is a `next` prerelease; the bare name for a stable CLI), because before 1.0 a bare name resolves the npm name placeholder. Third-party plugins are still installed by their bare name. The `doctor` hint for a missing `@strutvane/cli` names the same channel.
