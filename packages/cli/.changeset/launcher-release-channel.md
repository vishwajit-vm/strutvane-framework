---
"strutvane": patch
---

`strutvane new` and `strutvane create` run `create-strutvane` from the launcher's own release channel: a `0.1.0-next.N` launcher runs `create-strutvane@next`, a stable launcher `create-strutvane@latest`. Previously `@latest` was always used, which before 1.0 resolves only the npm name placeholder and fails with "could not determine executable to run". The channel is the prerelease id, derived as the release workflow derives the dist-tag; anything that is not strict semver or not a plain lowercase id falls back to `latest`. `help` and the "needs a Strutvane project" message name the same channel (`pnpm add -D @strutvane/cli@next`), and `doctor --global` never passes a version that is not strict semver to npx.
