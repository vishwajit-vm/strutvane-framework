---
"@strutvane/framework": patch
---

Projects reached through a symlink or junction (for example any temp folder on macOS, where `/var` links to `/private/var`) now work like projects reached by their real path. `node strut migrate --seed` and `db:seed` find and name every seeder, and policy boot errors name the file inside the app. The project root is now resolved to its real path once, before anything else runs. Symlink protections are unchanged: a link inside the project that points outside it is still refused.
