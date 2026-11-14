---
"@strutvane/framework": minor
---

Safer defaults across the API, runtime and storage:

- Hidden fields are never writable and cannot be filterable, sortable or searchable; hidden and sensitive field keys are offered to the logger at boot (`logger.redactKeys` hook).
- Creates and updates are checked against the actor's policy filter after the write, in the same transaction (`Scope.check`); record-level `can()` for updates sees the resulting row; `resource.beforeQuery` results are combined with the policy filter; `belongsTo` references must be visible to the actor (`Scope.references`).
- List cost limits: offset pages up to `MAX_OFFSET` rows deep, totals only with `allowTotal: true`, `pageSize.max` applied to `POST /query`, deduplicated and capped includes, and a default 5 s Postgres `statement_timeout`.
- Client filters reject `$actor` references and malformed nodes (422 `invalid_filter`); custom route `json()` requires a JSON content type.
- The manifest lists only resources the caller can use; `/openapi.json` is for identified callers outside local development (`openapi` option).
- HTTP hook payload types and names now come from `@strutvane/contracts` (re-exported); `http.onRequest` receives `clientAddress`. New `trustProxy` and `publicUrl` options (HSTS behind a TLS-terminating proxy; forwarded headers and `X-Request-Id` only from trusted proxies) and a `Permissions-Policy` header.
- `serve` aborts `request.signal` on disconnect, cancels response bodies, honours backpressure and does not stream `HEAD` bodies; handlers receive `{ incoming, clientAddress }` as a second argument.
- Uploads: a total deadline (`totalTimeoutMs`), the idle timer reset by every byte, prototype-free field maps, stricter active-content detection, and wildcards that never match active content. Storage keys are lowercase without trailing dots or device names; `storage.forTenant()` and `store(…, { tenantId })` scope keys per tenant. Signed URLs use an HKDF subkey; `serveSignedFile` and `createHttpApp({ signedFiles })` serve them.
- `tenancyAudit()` also checks table ownership, view `security_invoker`, `SECURITY DEFINER` functions and the tenant expression of restrictive policies.
