---
"@strutvane/framework": patch
---

Includes follow field-level read rules: when the PermissionProvider implements `filterableFields`, an include is refused (`include_not_allowed`) unless the actor may read its link field (the `belongsTo` field, or the target's foreign key for a `hasMany` relation), on list, show and `POST /query`.
