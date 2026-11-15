---
"@strutvane/framework": patch
---

`sv registry:watch` no longer hangs after a failed start. When the first build failed (for example because `.strutvane` is a link), the error was reported but the file watchers it had already opened kept the process alive; they are now closed before the error is thrown.
