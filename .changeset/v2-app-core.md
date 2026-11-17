---
'@strutvane/framework': minor
---

The v2 application core (Laravel's flow): `Application.configure({ basePath }).withRouting().withMiddleware().withExceptions().withCommands().create()` in `bootstrap/app.ts`, routing (`Route`, `defineRoutes`, resources, signed URLs, a typed callable `route()`), the HTTP kernel with middleware and protections, form requests, the exception handler and dev error page, the security kit (keyring with `APP_PREVIOUS_KEYS`, one URL signer, AES-GCM, SSRF-safe `HttpClient`, CORS, CSP nonces), maintenance mode, the cache (`memory`, `file`) and session stores, facades on the new `@strutvane/framework/facades` subpath, and the app commands (`optimize`, `config:cache`, `route:cache`, `event:cache`, `route:list --security`, `key:rotate`, `env:encrypt`/`env:decrypt`, `down`/`up`, `cache:clear`, `session:flush`, `security:check`, `make:command`/`make:rule`/`make:observer`).

`node strut start`/`dev` serve `bootstrap/app.ts` (booted before the port opens); the Node adapter passes the socket peer and `waitUntil`; `trustProxy` accepts a list of proxy addresses or CIDR ranges; HSTS is sent in production only; `node strut list` is the listing command (`help` is an alias); every message says `node strut`.

**Breaking (pre-1.0, CONSISTENCY #123):** every error code is now lowercase `snake_case` (`NOT_FOUND` → `not_found`, `VALIDATION_FAILED` → `validation_failed`, CLI and devkit codes alike). The old names keep working through 0.2 with a `DeprecationWarning`; `LEGACY_ERROR_CODES` lists every rename. Validation issues gain a `field` member with the dotted path (CONSISTENCY #69).
