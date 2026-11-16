---
"@strutvane/framework": patch
---

On Windows, the built-UI static file server refuses 8.3 short names (`/ENV~1` would open `.env`) and path segments ending in a dot or a space (`/secret.` opens `secret`), which got past the dot-file check.
