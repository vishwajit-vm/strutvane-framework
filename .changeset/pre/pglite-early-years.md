---
"@strutvane/framework": patch
---

On PGlite, datetimes in years 0001–0099 read back correctly. PGlite parsed `timestamptz` text with JavaScript's legacy date parser, which turned `0050` into `1950` and `0001` into `2001`; the driver now parses timestamps itself (`parsePgTimestamp`).
