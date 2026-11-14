---
"@strutvane/cli": patch
---

`make:policy` templates use the role names of `config/auth.ts` (docs/07 §2.7): `admin`, `member`, `viewer`, and `owner` for a tenant's creator. Readers now include `viewer`; the `owner` template limits own-record rules to `member`; the `tenant-admin` template grants writes to `admin` and `owner` with `scope: 'tenant'` instead of a `tenant-admin` role no app defines. Long rules are printed the way Biome formats them.
