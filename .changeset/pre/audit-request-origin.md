---
"@strutvane/framework": patch
---

`serve` appends the request path to the bind or public origin instead of resolving it as a relative URL, so no request target can change the origin the app sees in `request.url`.
