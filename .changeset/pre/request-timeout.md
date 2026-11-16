---
"@strutvane/framework": patch
---

Requests are bounded: when the app takes longer than `requestTimeoutMs` (a `createHttpApp` option, default `DEFAULT_REQUEST_TIMEOUT_MS`, 30 s; `0` disables it) to produce a response, the client gets a 503 `SERVICE_UNAVAILABLE` problem. It covers handlers, middleware and `http.onRequest` hooks that never settle, which used to hold the client and its socket forever. A failure of the abandoned work after the answer is contained. Routes can set `timeoutMs`; a route that raises `bodyLimit` (an upload endpoint) defaults to `UPLOAD_REQUEST_TIMEOUT_MS` (130 s), above the multipart parser's own deadlines. A streamed response body is not cut once it has started.
