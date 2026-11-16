---
"@strutvane/framework": patch
---

Values written to `.env` files now read back unchanged with the runtime loader. A value containing `"` or `\` is single-quoted (taken literally) instead of escaped, because Node's `.env` parser does not understand those escapes. A value that no quoting style can carry unchanged (one with both `'` and `"`, or a control character) is refused with `INVALID_ENV_VALUE` instead of being written in a form the app would read differently. The CLI's `.env` checks also read values containing U+2028 or U+2029.
