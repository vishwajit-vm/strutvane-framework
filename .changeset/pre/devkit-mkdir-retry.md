---
"@strutvane/framework": patch
---

Devkit creates folders (`mkdir -p` before writing or renaming a file) with the same bounded Windows retry as renames. A filter driver briefly refusing to create a parent folder made Node report ENOENT for the new folder and rolled the whole change back.
