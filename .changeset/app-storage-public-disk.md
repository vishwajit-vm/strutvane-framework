---
'@strutvane/framework': minor
---

Storage in the v2 Application: `config/filesystems.ts` is read at boot (disks and default disk; a private `local` disk without it), so the `Storage` facade works, and every public disk is served under its `url` path (the skeleton's `/storage/...`): GET/HEAD only, safe keys (no traversal, no listing, no metadata files), only files stored as public, `nosniff`, a sandboxing CSP, active content as an attachment, ETag/304. New `node strut storage:link [--force]` links `public/storage` to the public disk.

Security fix: active content stored with a parametrised or differently cased type (`text/html; charset=utf-8`, `Text/HTML`, any `+xml`) was served inline by signed links; `isActiveContent()` now normalises the type for both file servers.
