---
"@strutvane/framework": patch
---

`http.onResponse` payloads carry `route`, the matched route template (undefined for unmatched requests). Multipart parsing never writes to a temp file after the upload has been rejected.
