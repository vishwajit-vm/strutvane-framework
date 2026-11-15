---
"@strutvane/framework": patch
---

`defineEnv` errors never show a variable's value, even when the validator quotes the received input in its message (some Standard Schema validators and custom messages do). The value is replaced with `[REDACTED]`; values shorter than four characters are left as they are.
