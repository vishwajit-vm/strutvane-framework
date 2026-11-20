---
"@strutvane/framework": minor
---

A generated app (`bootstrap/app.ts`) now runs end to end on one port (demo acceptance FW-1, FW-2, FW-3, FW-6, FW-9, FW-11, FW-14, DOCK-2).

- `node strut dev` and `node strut build` boot the application instead of asking for a `strutvane.config.ts`. `dev` mounts the project's own Vite on the app's port (HMR included) and watches `app/`, `bootstrap/`, `config/`, `routes/`, `.strutvane/resources.json` and `.env`.
- `node strut start` serves the built UI from `dist/web` next to the API: hashed assets cached for a year, `index.html` never cached, SPA fallback for navigations, a page CSP. New `Application.serveUi({ files | fallthrough })`: only `GET`/`HEAD` requests that no route or request hook answered, never under the API base path or the framework's own paths.
- `GET /.well-known/strutvane.json`: the resource manifest `@strutvane/ui` loads its screens from, built from the app's `ResourceController` routes and `.strutvane/resources.json`, with per-actor capabilities from the same policies the API enforces. Private, never cached by a shared cache.
- The server binds `--host`, else `config('app.host')`, else `APP_HOST` (the generated compose file sets `0.0.0.0`), else `127.0.0.1`. With a wildcard bind, request URLs use the loopback address, so the trusted-hosts check no longer refuses every request inside a container; the `Host` header is checked as before. A malformed `APP_HOST` stops the start with `invalid_app_host`.
- `node strut doctor` checks that an application boots, that `.strutvane/resources.json` exists and that every installed add-on with a provider is registered in `bootstrap/providers.ts`; `node strut models` and `node strut permissions` read the application (resources.json; abilities, policies and the routes that use them); `registry:build` explains that an application has no registry.
- New `node strut design:use <crisp|vivid>`: installs the design package, updates `config/ui.ts`, `resources/ui/main.tsx` and `strutvane.json`, removes the old design and keeps `theme.css`.
- The 503 of maintenance mode is no longer reported as an error with a stack.
- Logging moved into the framework (the `v2/logging` changes, merged here): logs go to `storage/logs` as `config/logging.ts` says.
