---
"@strutvane/framework": patch
---

Generators and installers on Windows ride out files that another process holds open (antivirus scanners, indexers, editors), for up to about 3 s instead of 0.3 s, before a change is rolled back. `make:model --force` over a file that a scanner had just opened used to fail with `TRANSACTION_ABORTED` (EPERM on rename). Each wait is capped at 500 ms, so a file that stays locked still fails the change instead of hanging the command.
