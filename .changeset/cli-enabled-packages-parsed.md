---
"@strutvane/framework": patch
---

The package-migration gate now reads which packages `strutvane.config.ts` enables by parsing its imports. An import inside a block comment or a string, or one that imports only types, no longer enables a package's migrations, and a config file that does not parse enables none.
