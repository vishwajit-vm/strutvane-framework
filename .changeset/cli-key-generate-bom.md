---
"@strutvane/framework": patch
---

`sv key:generate --force` now replaces an `APP_KEY` on the first line of a `.env` saved with a byte-order mark. Before, it reported success and left the old key in place.
