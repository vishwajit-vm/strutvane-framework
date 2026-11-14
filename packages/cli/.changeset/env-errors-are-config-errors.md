---
"@strutvane/cli": patch
---

An invalid app environment is reported as a configuration error instead of an unexpected one. When a command (built-in or contributed) fails with core's `EnvValidationError`, also when it arrives as the `cause` of another error, the CLI lists each problem by variable name, prints how to fix the `.env` file, and exits with code 3 (validation). The error code in the `--json` envelope is `ENV_INVALID`. The error is matched by its `name` and `problems` list, so a contributed command that bundles its own copy of core is classified the same way.
