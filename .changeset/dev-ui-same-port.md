---
"@strutvane/framework": minor
---

`sv dev` serves the API and the web UI on one port: it mounts the project's own Vite (resolved from the project's `node_modules`, so the framework has no Vite dependency) in middleware mode, with HMR over the same server, for `GET`/`HEAD` requests the API did not answer outside the API base path and framework paths. Without a `vite.config.*` or an installed `vite`, it serves the API only and says so. New building blocks: `createHttpApp({ uiFallthrough })`, `serve({ prepare, fallback })`, `startServer({ vite })`, and one shared rule for the paths the UI may answer (also used for `dist/web` in `sv start`). `sv build` finds any `vite.config.*` and the project's Vite the same way.
