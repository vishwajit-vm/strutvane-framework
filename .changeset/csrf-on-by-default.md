---
"@strutvane/framework": minor
---

CSRF protection is on by default. Every POST, PUT, PATCH or DELETE that carries the session cookie must come from the app's own pages (`Sec-Fetch-Site: same-origin`, an exact `Origin`, or a token in `X-XSRF-TOKEN`, `X-CSRF-TOKEN` or a form's `_token`), otherwise it gets a 419 problem with code `csrf_token_mismatch`. This covers the CRUD routes (restore included), custom routes with or without a body, and routes a request hook answers. The framework sets an `XSRF-TOKEN` cookie for front-end code, kept in step with the session. Bearer-token requests without the session cookie are not checked. The session cookie's name has one source, `config/session.ts` `cookie` (default `strutvane_session`, `__Host-` added on https), published as `SessionCookieToken`; callback paths a third party posts to go in `config/session.ts` `csrf.except`. Error codes may now be `snake_case`.
