---
"@strutvane/framework": patch
---

Text fields refuse NUL characters (`invalid_format`) instead of failing inside PostgreSQL with a 500, and required string/text fields refuse empty or whitespace-only values (`required`). Manifest capabilities for row actions follow the same rule as the API: allowed when the row filter is not FALSE, so a member who may edit only their own records still sees Edit and Delete.
