---
"@strutvane/framework": patch
---

List queries honour `PermissionProvider.filterableFields` when the provider implements it: filters, sorts and `POST /query` accept only the returned fields (422 otherwise), and search skips searchable fields outside the set. Providers without the method behave as before. New helper: `narrowQueryFields`, plus `ListOptions.allowedFields` on the repository.
