---
"@strutvane/framework": patch
---

`ConfigOf` and `RoutesOf` are now exported from `@strutvane/framework`, so an app can write the typed-registry block the docs describe (`interface RouteRegistry extends RoutesOf<[typeof web, typeof api]> {}`, `interface ConfigRegistry extends ConfigOf<typeof config> {}`) importing only from the package. In 0.2.0-next.0 they existed but were not exported.
