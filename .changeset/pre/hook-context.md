---
"@strutvane/framework": minor
---

Resource hook contexts gain `repositoryFor(model)`, `scope` (the request tenant) and `app`, so a hook can update another model (invoice totals from its lines) or clean up stored files.
