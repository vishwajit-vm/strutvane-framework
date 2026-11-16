---
"@strutvane/framework": patch
---

A rejected multipart upload no longer leaves a 2-second timer running after it. The wait for temp files to close now clears its timer. Before, every failed upload kept one timer alive, which delayed process exit and piled up under a flood of bad uploads.
