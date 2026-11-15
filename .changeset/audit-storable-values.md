---
"@strutvane/framework": patch
---

Create and update validation now accepts only values every engine can store: 64-bit range for `bigInteger`, years 0001-9999 (after converting to UTC) for `date` and `datetime`, and no U+0000 inside `json` values. Such values used to pass validation and fail on write as a 500; they are now a 422 on the field, and the same dates as filter operands are a 422 too.
