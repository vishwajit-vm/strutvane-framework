---
"@strutvane/framework": minor
---

A Host allowlist now guards every request in every environment, local development included. `localhost`, `127.0.0.1`, `[::1]` and the `APP_URL` host are always allowed, plus `config/app.ts` `trustedHosts` (exact names or `*.example.com`); any other `Host` (or, behind a trusted proxy, `X-Forwarded-Host`) gets a 400 problem with code `untrusted_host` before any hook or route runs. This stops DNS rebinding of the dev API and dev UI and host-header poisoning in production. If you reach a dev server by a LAN address or another name, add it to `trustedHosts`.
