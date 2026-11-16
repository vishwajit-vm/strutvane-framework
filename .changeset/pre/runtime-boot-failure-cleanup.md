---
"@strutvane/framework": patch
---

When a provider fails to boot (`sv dev`, `sv start`), the providers that had already booted are shut down again in reverse order. Before, their connections stayed open and could keep the process running after the error was reported.
