---
"@strutvane/framework": patch
---

File transactions are sturdier on Windows. Renames and deletes retry briefly while another program (an antivirus scanner, an indexer, an editor) holds the file, instead of rolling the whole change back. The transaction journal is now deleted before the rest of the staging folder, so a failure to clean up after a successful change can no longer leave a journal that would make `sv recover` undo it.
