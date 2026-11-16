---
"@strutvane/framework": patch
---

`tenancyAudit` now requires a tenant table's restrictive policy to be exactly the tenant comparison in both `USING` and `WITH CHECK`; a policy that mentions the tenant setting but ORs anything else in is reported as `tenant-policy-mismatch`.
