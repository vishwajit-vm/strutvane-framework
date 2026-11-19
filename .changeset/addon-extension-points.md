---
'@strutvane/framework': minor
---

Extension points for add-on packages: `app.env(name)` (the merged environment, readable in `register()`), `app.addMessages(...catalogs)` (package message catalogs at boot), `CacheDriverRegistryToken` (packages add cache drivers that `config/cache.ts` stores can use), and root exports of `allows`, `authorize`, `hasAdminRole`, `Policy`, `PolicyRegistry`/`PolicyRegistryToken` (with `registry.allows()`/`authorize()`, deny without a policy), `RateLimitStoreToken`, `UsedSignatureStoreToken`, `MemoryUsedSignatureStore` and `MemoryCacheStore`. `@strutvane/framework/testing` now exports `testClient` (classes as `AppTestClient`/`AppTestResponse`).
