---
"@strutvane/framework": patch
---

`APP_ENV` is trimmed and lowercased everywhere (an empty value counts as unset), matching the CLI. Contributed commands use the value the CLI resolved (`ctx.appEnv`, else `ctx.services.env.APP_ENV`) instead of re-reading `.env`; `loadProject(root, { appEnv })` applies it before config loads.
