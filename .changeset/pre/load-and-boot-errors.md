---
"@strutvane/framework": patch
---

Startup failures are reported as configuration problems, not as framework bugs:
- A project file that cannot be loaded (a syntax error, a throw at the top level of `config/*.ts`, a model or a route file) is a `ProjectLoadError` (`code: 'PROJECT_INVALID'`) naming the file. The CLI shows it with a fix hint and exits 3. Before it printed Node's bare message ("Unexpected error: Expression expected … report the bug").
- A provider that fails to boot (the database is down at startup) is `BOOT_FAILED` in the CLI, naming the provider, with a hint to check the service and its settings; a boot that never finishes is `BOOT_TIMEOUT`. Both exit 1.
