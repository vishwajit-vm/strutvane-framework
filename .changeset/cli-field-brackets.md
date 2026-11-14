---
"@strutvane/cli": patch
---

Field specs accept square brackets wherever they accept parentheses: `name:string[120]:required`, `amount:decimal[12,2]:min[0]`, `status:enum[draft,paid]:default[draft]`, `customer:belongsTo[Customer]`. Both spellings mean the same. On Windows, PowerShell runs `corepack pnpm sv`, `pnpm sv` and `npx` through `.cmd` shims, where parentheses in an argument fail with "… was unexpected at this time" before the CLI starts; brackets and commas pass through unchanged. Inside brackets, quote text with single quotes (`"due:date:label['Due date']"`), because PowerShell 5.1 drops double quotes inside an argument. `sv help make:model` shows the bracket form first on Windows, and `formatFieldSpec(field, { brackets: true })` prints it.
