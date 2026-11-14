---
"@strutvane/framework": minor
---

`GET /docs` serves a readable page for the OpenAPI document, next to `/openapi.json` and under the same visibility rule (public in `APP_ENV=local` or when `openapi: 'public'`, identified callers elsewhere, absent with `openapi: false` / `API_DOCS=false`). It is server-rendered with no scripts, a CSP that allows only inline styles, and every document value escaped.
