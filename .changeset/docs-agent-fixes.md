---
'@strutvane/framework': patch
---

Fixes found while writing the 0.2 docs:
- `node strut start` and `dev` accept `--force-debug`, the flag the `debug_in_production` hint names.
- A 415 for a JSON body or a CSP report said "Send the request body as {expected}."; it now names the media type.
- `route:list` printed `throttle:60:1`; it now writes `throttle:60,1` like routes and `--security`.
- Schema, migration and sandbox errors reached the CLI as "Unexpected error"; they keep their code, location and hint.
- `make:model`, `make:factory` and `make:seeder` wrote 0.1 files in migration-first apps; they now write the skeleton's shapes (`Model('posts')`, the `create_posts_table` migration, `defineFactory`, `defineSeeder` registered between the markers, a deny-by-default policy). Field specs are refused there: columns belong in the migration.
- `app.previous_keys: env.optional('APP_PREVIOUS_KEYS')` (or an optional `APP_KEY`) left unset was read as the text "undefined" and refused boot.
