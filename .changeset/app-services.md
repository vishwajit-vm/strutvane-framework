---
"@strutvane/framework": minor
---

Custom route handlers get the app's services: `repository(model)`, `scope`, `scopeFor(model, action)` (tenant plus policy filter), `authorize(permission, record?)`, `storage`, `app` and `multipart(limits)` (temp files always cleaned up), plus a per-route `bodyLimit`. The project runtime reads `config/filesystems.ts`, signs temporary links with `APP_KEY` and serves them at `/storage/<disk>`, and `sv start` serves the built UI from `dist/web` (`createHttpApp({ staticFiles })`).
