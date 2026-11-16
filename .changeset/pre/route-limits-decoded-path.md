---
"@strutvane/framework": patch
---

Per-route `bodyLimit` and `timeoutMs` are matched on the path the router serves (percent-decoded), so `/api/v1/upl%6Fads` gets the `/uploads` route's own limit and timeout instead of the app-wide ones. A lowered limit can no longer be dodged by encoding a letter of the path.
