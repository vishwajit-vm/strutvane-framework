---
"@strutvane/framework": minor
---

Write hooks run in two stages. The new `onWrite(change, ctx)` resource hook and the `resource.onWrite` hook run inside the write's transaction (with `ctx.db`, and repositories bound to it): a failure rolls the write back and answers with that error, which is where audit records belong. After the commit, `after*` hooks, the new `afterCommit(change, ctx)` hook, `resource.afterCommit` handlers and the domain event run; a failure there is logged and no longer turns the response into a 500 for a write that succeeded. Repository writes accept `{ onWrite(record, tx) }` for the same guarantee in custom code.
